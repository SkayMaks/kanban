/* ============================================================
   КАНБАН · script.js  (Supabase edition)
   ============================================================ */

const SESSION_KEY = 'kanban_session_v2';
const THEME_KEY   = 'kanban_theme';

const STATUSES = [
  { id: 'todo',        title: 'Нужно сделать', colorVar: '--col-todo' },
  { id: 'analysis',    title: 'В анализе',     colorVar: '--col-analysis' },
  { id: 'in_progress', title: 'В работе',      colorVar: '--col-progress' },
  { id: 'review',      title: 'Ревью',         colorVar: '--col-review' },
  { id: 'done',        title: 'Готово',        colorVar: '--col-done' },
];

const PRIORITY_LABELS = { high: 'Высокий', medium: 'Средний', low: 'Низкий' };
const MONTHS = ['Январь','Февраль','Март','Апрель','Май','Июнь','Июль','Август','Сентябрь','Октябрь','Ноябрь','Декабрь'];

const SWATCH_COLORS = [
  '#3b82f6','#10b981','#f59e0b','#ef4444','#8b5cf6','#ec4899',
  '#06b6d4','#84cc16','#f97316','#6366f1','#14b8a6','#d946ef',
  '#7c5cff','#0ea5e9','#22c55e','#eab308'
];

// ============================================================
// СОСТОЯНИЕ
// ============================================================
let supabase = null;
let currentUser = null;
let activeTab = 'board';
let filters = { search: '', mine: false, priority: '', category: '' };
let dragState = { taskId: null };

// Локальные кэши (зеркало БД)
let cache = {
  users: [],
  categories: [],
  tasks: [],
  archive: [],
  meta: { last_monthly_check: null }
};

// ============================================================
// ИНИЦИАЛИЗАЦИЯ КЛИЕНТА SUPABASE
// ============================================================
function initSupabase() {
  if (!window.SUPABASE_URL || window.SUPABASE_URL.includes('YOUR-PROJECT')) {
    showConnectionError('⚠ Не настроен config.js — впиши SUPABASE_URL и SUPABASE_KEY');
    return false;
  }
  if (!window.supabase || !window.supabase.createClient) {
    showConnectionError('⚠ SDK не загрузился. Проверь интернет');
    return false;
  }
  try {
    supabase = window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_KEY, {
      auth: { persistSession: false }   // мы используем свою авторизацию, Supabase Auth не нужен
    });
    return true;
  } catch (e) {
    showConnectionError('⚠ Не удалось создать клиент: ' + e.message);
    return false;
  }
}

function showConnectionError(text) {
  const el = document.getElementById('connection-status');
  el.textContent = text;
  el.classList.add('error');
}

function setSyncStatus(state) {
  // state: 'online' | 'offline' | 'connecting'
  const el = document.getElementById('sync-indicator');
  if (!el) return;
  el.classList.remove('offline', 'connecting');
  if (state === 'offline') el.classList.add('offline');
  else if (state === 'connecting') el.classList.add('connecting');
  el.title = {
    online: 'Real-time подключение активно',
    offline: 'Нет связи с БД',
    connecting: 'Подключение…'
  }[state] || '';
}

// ============================================================
// АВТОРИЗАЦИЯ ЧЕРЕЗ ТАБЛИЦУ users
// ============================================================
async function tryLogin(login, password) {
  const { data, error } = await supabase
    .from('users')
    .select('*')
    .eq('login', login)
    .eq('password', password)
    .maybeSingle();
  if (error) {
    console.error(error);
    return { user: null, error: 'Ошибка соединения с БД' };
  }
  if (!data) return { user: null, error: 'Неверный логин или пароль' };
  return { user: data, error: null };
}

async function restoreSession() {
  const uid = sessionStorage.getItem(SESSION_KEY);
  if (!uid) return false;
  const { data } = await supabase.from('users').select('*').eq('id', uid).maybeSingle();
  if (!data) { sessionStorage.removeItem(SESSION_KEY); return false; }
  currentUser = data;
  return true;
}

function logout() {
  sessionStorage.removeItem(SESSION_KEY);
  currentUser = null;
  unsubscribeRealtime();
  document.getElementById('app').classList.add('hidden');
  document.getElementById('login-screen').classList.remove('hidden');
  document.getElementById('login-form').reset();
}

// ============================================================
// ЗАГРУЗКА ВСЕХ ДАННЫХ
// ============================================================
async function loadAllData() {
  const [usersRes, catsRes, tasksRes, archiveRes, metaRes] = await Promise.all([
    supabase.from('users').select('*'),
    supabase.from('categories').select('*'),
    supabase.from('tasks').select('*'),
    supabase.from('archive').select('*'),
    supabase.from('meta').select('*').eq('id', 1).maybeSingle()
  ]);

  for (const r of [usersRes, catsRes, tasksRes, archiveRes]) {
    if (r.error) { console.error(r.error); throw r.error; }
  }

  cache.users = usersRes.data || [];
  cache.categories = catsRes.data || [];
  cache.tasks = (tasksRes.data || []).map(fromDbTask);
  cache.archive = (archiveRes.data || []).map(fromDbTask);
  cache.meta = metaRes.data || { id: 1, last_monthly_check: new Date().toISOString().slice(0,10) };
}

// ============================================================
// ПРЕОБРАЗОВАНИЯ db ↔ JS
// (snake_case в БД ↔ camelCase в JS)
// ============================================================
function fromDbTask(row) {
  if (!row) return row;
  return {
    id: row.id,
    title: row.title,
    description: row.description || '',
    status: row.status,
    priority: row.priority,
    categoryId: row.category_id,
    assigneeId: row.assignee_id,
    deadline: row.deadline || '',
    repeatMonthly: !!row.repeat_monthly,
    createdAt: row.created_at,
    archivedAt: row.archived_at
  };
}

function toDbTask(t) {
  return {
    id: t.id,
    title: t.title,
    description: t.description || '',
    status: t.status,
    priority: t.priority,
    category_id: t.categoryId || null,
    assignee_id: t.assigneeId || null,
    deadline: t.deadline || null,
    repeat_monthly: !!t.repeatMonthly,
    created_at: t.createdAt || new Date().toISOString()
  };
}

// ============================================================
// REAL-TIME ПОДПИСКИ
// ============================================================
let realtimeChannel = null;

function subscribeRealtime() {
  if (realtimeChannel) return;
  setSyncStatus('connecting');

  realtimeChannel = supabase.channel('kanban-changes')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'tasks' },     handleTaskChange)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'archive' },   handleArchiveChange)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'categories' },handleCategoryChange)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'users' },     handleUserChange)
    .subscribe(status => {
      if (status === 'SUBSCRIBED') setSyncStatus('online');
      else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') setSyncStatus('offline');
    });
}

function unsubscribeRealtime() {
  if (realtimeChannel) {
    supabase.removeChannel(realtimeChannel);
    realtimeChannel = null;
  }
  setSyncStatus('offline');
}

function handleTaskChange(payload) {
  const { eventType, new: newRow, old: oldRow } = payload;
  if (eventType === 'INSERT') {
    if (!cache.tasks.find(t => t.id === newRow.id)) cache.tasks.push(fromDbTask(newRow));
  } else if (eventType === 'UPDATE') {
    const idx = cache.tasks.findIndex(t => t.id === newRow.id);
    if (idx !== -1) cache.tasks[idx] = fromDbTask(newRow);
    else cache.tasks.push(fromDbTask(newRow));
  } else if (eventType === 'DELETE') {
    cache.tasks = cache.tasks.filter(t => t.id !== oldRow.id);
  }
  if (activeTab === 'board') renderBoard();
}

function handleArchiveChange(payload) {
  const { eventType, new: newRow, old: oldRow } = payload;
  if (eventType === 'INSERT') {
    if (!cache.archive.find(t => t.id === newRow.id)) cache.archive.push(fromDbTask(newRow));
  } else if (eventType === 'UPDATE') {
    const idx = cache.archive.findIndex(t => t.id === newRow.id);
    if (idx !== -1) cache.archive[idx] = fromDbTask(newRow);
  } else if (eventType === 'DELETE') {
    cache.archive = cache.archive.filter(t => t.id !== oldRow.id);
  }
  if (activeTab === 'archive') renderArchive();
}

function handleCategoryChange(payload) {
  const { eventType, new: newRow, old: oldRow } = payload;
  if (eventType === 'INSERT') cache.categories.push(newRow);
  else if (eventType === 'UPDATE') {
    const idx = cache.categories.findIndex(c => c.id === newRow.id);
    if (idx !== -1) cache.categories[idx] = newRow;
  } else if (eventType === 'DELETE') {
    cache.categories = cache.categories.filter(c => c.id !== oldRow.id);
  }
  renderFiltersOptions();
  if (activeTab === 'board') renderBoard();
}

function handleUserChange(payload) {
  const { eventType, new: newRow, old: oldRow } = payload;
  if (eventType === 'INSERT') cache.users.push(newRow);
  else if (eventType === 'UPDATE') {
    const idx = cache.users.findIndex(u => u.id === newRow.id);
    if (idx !== -1) cache.users[idx] = newRow;
  } else if (eventType === 'DELETE') {
    cache.users = cache.users.filter(u => u.id !== oldRow.id);
  }
  if (activeTab === 'board') renderBoard();
}

// ============================================================
// ЕЖЕМЕСЯЧНОЕ ОБСЛУЖИВАНИЕ
// ============================================================
async function runMonthlyMaintenance() {
  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);
  const lastStr = cache.meta?.last_monthly_check || todayStr;

  const last = new Date(lastStr + 'T00:00:00');
  const lastYM = last.getFullYear() * 12 + last.getMonth();
  const todayYM = today.getFullYear() * 12 + today.getMonth();

  if (todayYM <= lastYM) return;

  // 1. Архивируем все done
  const doneTasks = cache.tasks.filter(t => t.status === 'done');
  if (doneTasks.length) {
    const archiveRows = doneTasks.map(t => ({
      ...toDbTask(t),
      archived_at: new Date().toISOString()
    }));
    const { error: archErr } = await supabase.from('archive').insert(archiveRows);
    if (!archErr) {
      const ids = doneTasks.map(t => t.id);
      await supabase.from('tasks').delete().in('id', ids);
    }
  }

  // 2. Создаём новые экземпляры повторяющихся
  const templates = collectRepeatTemplates();
  const toInsert = [];
  for (const tpl of templates) {
    const existsActive = cache.tasks.some(t =>
      t.repeatMonthly && t.title === tpl.title && t.description === tpl.description &&
      t.status !== 'done'
    );
    if (!existsActive) {
      toInsert.push({
        id: 't_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
        title: tpl.title,
        description: tpl.description || '',
        status: 'todo',
        priority: tpl.priority,
        category_id: tpl.categoryId || null,
        assignee_id: null,
        deadline: null,
        repeat_monthly: true,
        created_at: new Date().toISOString()
      });
    }
  }
  if (toInsert.length) await supabase.from('tasks').insert(toInsert);

  // 3. Обновляем метку
  await supabase.from('meta').upsert({ id: 1, last_monthly_check: todayStr });
  cache.meta.last_monthly_check = todayStr;

  if (doneTasks.length || toInsert.length) {
    showToast(`Новый месяц: архивировано ${doneTasks.length}, создано повторов ${toInsert.length}`);
  }
}

function collectRepeatTemplates() {
  const seen = new Set();
  const templates = [];
  const candidates = [
    ...cache.tasks.filter(t => t.repeatMonthly),
    ...cache.archive.filter(t => t.repeatMonthly)
  ];
  for (const t of candidates) {
    const key = (t.title || '') + '|' + (t.description || '');
    if (seen.has(key)) continue;
    seen.add(key);
    templates.push(t);
  }
  return templates;
}

// ============================================================
// CRUD: ЗАДАЧИ
// ============================================================
async function createTask(data) {
  const id = 't_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
  const task = {
    id, ...data,
    assigneeId: data.assigneeId || currentUser.id,
    createdAt: new Date().toISOString()
  };
  // оптимистичное обновление кэша
  cache.tasks.push(task);
  renderBoard();

  const { error } = await supabase.from('tasks').insert(toDbTask(task));
  if (error) {
    cache.tasks = cache.tasks.filter(t => t.id !== id);
    renderBoard();
    showToast('Ошибка: не удалось сохранить');
    console.error(error);
    return;
  }
  showToast('Задача создана');
}

async function updateTask(id, patch) {
  const idx = cache.tasks.findIndex(t => t.id === id);
  if (idx === -1) return;
  const before = { ...cache.tasks[idx] };
  Object.assign(cache.tasks[idx], patch);
  renderBoard();

  const dbPatch = {};
  if ('title' in patch)         dbPatch.title = patch.title;
  if ('description' in patch)   dbPatch.description = patch.description;
  if ('status' in patch)        dbPatch.status = patch.status;
  if ('priority' in patch)      dbPatch.priority = patch.priority;
  if ('categoryId' in patch)    dbPatch.category_id = patch.categoryId || null;
  if ('assigneeId' in patch)    dbPatch.assignee_id = patch.assigneeId || null;
  if ('deadline' in patch)      dbPatch.deadline = patch.deadline || null;
  if ('repeatMonthly' in patch) dbPatch.repeat_monthly = !!patch.repeatMonthly;

  const { error } = await supabase.from('tasks').update(dbPatch).eq('id', id);
  if (error) {
    cache.tasks[idx] = before;
    renderBoard();
    showToast('Ошибка: изменения не сохранены');
    console.error(error);
  }
}

async function deleteTaskRemote(id) {
  const idx = cache.tasks.findIndex(t => t.id === id);
  if (idx === -1) return;
  const before = cache.tasks[idx];
  cache.tasks.splice(idx, 1);
  renderBoard();

  const { error } = await supabase.from('tasks').delete().eq('id', id);
  if (error) {
    cache.tasks.push(before);
    renderBoard();
    showToast('Ошибка: задача не удалена');
    console.error(error);
  } else {
    showToast('Задача удалена');
  }
}

async function moveTask(taskId, newStatus) {
  const task = cache.tasks.find(t => t.id === taskId);
  if (!task || task.status === newStatus) return;
  await updateTask(taskId, { status: newStatus, assigneeId: currentUser.id });
}

// ============================================================
// CRUD: КАТЕГОРИИ
// ============================================================
async function createCategory(name, color) {
  const id = 'c_' + Date.now() + '_' + Math.random().toString(36).slice(2, 5);
  const cat = { id, name, color };
  cache.categories.push(cat);
  renderFiltersOptions();
  renderBoard();
  const { error } = await supabase.from('categories').insert(cat);
  if (error) {
    cache.categories = cache.categories.filter(c => c.id !== id);
    renderFiltersOptions();
    renderBoard();
    showToast('Ошибка: категория не создана');
    return;
  }
  showToast('Категория добавлена');
}

// ============================================================
// АРХИВ
// ============================================================
async function restoreFromArchive(taskId) {
  const idx = cache.archive.findIndex(t => t.id === taskId);
  if (idx === -1) return;
  const t = cache.archive[idx];
  const restored = { ...t, status: 'todo' };
  delete restored.archivedAt;

  // оптимистично
  cache.archive.splice(idx, 1);
  cache.tasks.push(restored);
  renderArchive();
  renderBoard();

  const { error: insErr } = await supabase.from('tasks').insert(toDbTask(restored));
  if (insErr) { showToast('Ошибка: не восстановлено'); return; }
  await supabase.from('archive').delete().eq('id', taskId);
  showToast('Задача восстановлена в «Нужно сделать»');
}

async function clearArchive() {
  if (!cache.archive.length) return;
  if (!confirm('Очистить архив полностью?')) return;
  const ids = cache.archive.map(t => t.id);
  cache.archive = [];
  renderArchive();
  await supabase.from('archive').delete().in('id', ids);
  showToast('Архив очищен');
}

// ============================================================
// ЭКСПОРТ
// ============================================================
function exportJson() {
  const dump = {
    users: cache.users,
    categories: cache.categories,
    tasks: cache.tasks,
    archive: cache.archive,
    meta: cache.meta,
    exportedAt: new Date().toISOString()
  };
  const blob = new Blob([JSON.stringify(dump, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const stamp = new Date().toISOString().slice(0, 10);
  a.href = url;
  a.download = `kanban-${stamp}.json`;
  a.click();
  URL.revokeObjectURL(url);
  showToast('Файл сохранён');
}

// ============================================================
// РЕНДЕР
// ============================================================
function renderHeader() {
  const now = new Date();
  document.getElementById('month-title').textContent =
    `${MONTHS[now.getMonth()]} ${now.getFullYear()}`;

  const chip = document.getElementById('user-chip');
  chip.querySelector('.user-avatar').textContent = currentUser.name[0].toUpperCase();
  chip.querySelector('.user-avatar').style.background = currentUser.color;
  chip.querySelector('.user-name').textContent = currentUser.name;
}

function renderFiltersOptions() {
  const sel = document.getElementById('filter-category');
  const current = sel.value;
  sel.innerHTML = '<option value="">Все</option>' +
    cache.categories.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');
  sel.value = current;

  const taskSel = document.getElementById('task-category');
  taskSel.innerHTML = '<option value="">Без категории</option>' +
    cache.categories.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');
}

function renderBoard() {
  const board = document.getElementById('board');
  board.innerHTML = '';

  const filteredTasks = applyFilters(cache.tasks);

  STATUSES.forEach(status => {
    const col = document.createElement('div');
    col.className = 'column';
    col.dataset.status = status.id;
    col.style.setProperty('--col-color', `var(${status.colorVar})`);

    const tasks = filteredTasks.filter(t => t.status === status.id);

    col.innerHTML = `
      <div class="column-head">
        <div class="column-title">${escapeHtml(status.title)}</div>
        <span class="column-count">${tasks.length}</span>
      </div>
      <div class="column-body" data-drop="${status.id}">
        ${tasks.length
          ? tasks.map(renderCard).join('')
          : '<div class="card-empty">Перетащите сюда задачу</div>'
        }
      </div>
    `;
    board.appendChild(col);
  });

  attachCardEvents();
  attachDropEvents();
}

function renderCard(task) {
  const cat = cache.categories.find(c => c.id === task.categoryId);
  const assignee = cache.users.find(u => u.id === task.assigneeId);
  const catColor = cat ? cat.color : 'var(--border-strong)';
  const catColorSoft = cat ? hexToSoft(cat.color) : 'var(--surface-2)';

  const deadlineHtml = task.deadline ? renderDeadline(task.deadline) : '';
  const repeatHtml = task.repeatMonthly ? `<span class="tag tag-repeat">↻ ежемес.</span>` : '';
  const catHtml = cat ? `<span class="tag tag-category">${escapeHtml(cat.name)}</span>` : '';
  const desc = task.description ? `<div class="card-desc">${escapeHtml(task.description)}</div>` : '';

  const assigneeHtml = assignee
    ? `<span class="card-assignee">
         <span class="assignee-dot" style="--user-color:${assignee.color}">${assignee.name[0].toUpperCase()}</span>
         ${escapeHtml(assignee.name)}
       </span>`
    : `<span class="card-assignee">
         <span class="assignee-dot empty">·</span>
         <span style="color:var(--text-mute)">не назначено</span>
       </span>`;

  return `
    <div class="card" draggable="true" data-id="${task.id}"
         style="--cat-color:${catColor}; --cat-color-soft:${catColorSoft}">
      <div class="card-head">
        <div class="card-title">${escapeHtml(task.title)}</div>
        <div class="card-priority ${task.priority}" title="Приоритет: ${PRIORITY_LABELS[task.priority]}"></div>
      </div>
      ${desc}
      <div class="card-meta">${catHtml}${deadlineHtml}${repeatHtml}</div>
      <div class="card-foot">${assigneeHtml}</div>
    </div>
  `;
}

function renderDeadline(dateStr) {
  const today = new Date(); today.setHours(0,0,0,0);
  const dl = new Date(dateStr + 'T00:00:00');
  const diffDays = Math.round((dl - today) / 86400000);
  const overdue = diffDays < 0;
  const formatted = dl.toLocaleDateString('ru-RU', { day: '2-digit', month: 'short' });
  return `<span class="tag tag-deadline ${overdue ? 'overdue' : ''}">⏰ ${formatted}</span>`;
}

function applyFilters(tasks) {
  const q = filters.search.trim().toLowerCase();
  return tasks.filter(t => {
    if (q && !t.title.toLowerCase().includes(q) && !(t.description || '').toLowerCase().includes(q)) return false;
    if (filters.mine && t.assigneeId !== currentUser.id) return false;
    if (filters.priority && t.priority !== filters.priority) return false;
    if (filters.category && t.categoryId !== filters.category) return false;
    return true;
  });
}

// ============================================================
// DRAG & DROP
// ============================================================
function attachCardEvents() {
  document.querySelectorAll('.card').forEach(card => {
    card.addEventListener('dragstart', onDragStart);
    card.addEventListener('dragend', onDragEnd);
    card.addEventListener('click', () => {
      if (card.classList.contains('dragging')) return;
      openTaskModal(card.dataset.id);
    });
  });
}

function attachDropEvents() {
  document.querySelectorAll('.column-body').forEach(body => {
    const col = body.closest('.column');
    body.addEventListener('dragover', e => {
      e.preventDefault();
      col.classList.add('drag-over');
    });
    body.addEventListener('dragleave', e => {
      if (!col.contains(e.relatedTarget)) col.classList.remove('drag-over');
    });
    body.addEventListener('drop', e => {
      e.preventDefault();
      col.classList.remove('drag-over');
      const taskId = dragState.taskId;
      const newStatus = body.dataset.drop;
      if (!taskId || !newStatus) return;
      moveTask(taskId, newStatus);
    });
  });
}

function onDragStart(e) {
  dragState.taskId = e.currentTarget.dataset.id;
  e.currentTarget.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
}

function onDragEnd(e) {
  e.currentTarget.classList.remove('dragging');
  dragState.taskId = null;
  document.querySelectorAll('.column.drag-over').forEach(c => c.classList.remove('drag-over'));
}

// ============================================================
// АРХИВ-РЕНДЕР
// ============================================================
function renderArchive() {
  const list = document.getElementById('archive-list');
  if (!cache.archive.length) {
    list.innerHTML = '<div class="archive-empty">Архив пуст</div>';
    return;
  }
  list.innerHTML = cache.archive
    .slice()
    .sort((a, b) => (b.archivedAt || '').localeCompare(a.archivedAt || ''))
    .map(t => {
      const cat = cache.categories.find(c => c.id === t.categoryId);
      const assignee = cache.users.find(u => u.id === t.assigneeId);
      const catColor = cat ? cat.color : 'var(--border-strong)';
      const archDate = t.archivedAt
        ? new Date(t.archivedAt).toLocaleDateString('ru-RU', { day: '2-digit', month: 'short', year: 'numeric' })
        : '—';
      return `
        <div class="archive-item" style="--cat-color:${catColor}">
          <div>
            <div class="archive-item-title">${escapeHtml(t.title)}</div>
            <div class="archive-item-meta">
              ${cat ? escapeHtml(cat.name) + ' · ' : ''}архив: ${archDate}${assignee ? ' · ' + escapeHtml(assignee.name) : ''}
            </div>
          </div>
          <span class="card-priority ${t.priority}" title="${PRIORITY_LABELS[t.priority]}"></span>
          <button class="link-btn" data-restore="${t.id}">Восстановить</button>
        </div>
      `;
    }).join('');

  list.querySelectorAll('[data-restore]').forEach(btn => {
    btn.addEventListener('click', () => restoreFromArchive(btn.dataset.restore));
  });
}

// ============================================================
// МОДАЛКИ
// ============================================================
function openTaskModal(taskId = null) {
  const modal = document.getElementById('task-modal');
  const form = document.getElementById('task-form');
  form.reset();
  document.getElementById('task-id').value = '';
  renderFiltersOptions();

  if (taskId) {
    const t = cache.tasks.find(x => x.id === taskId);
    if (!t) return;
    document.getElementById('task-modal-title').textContent = 'Редактировать задачу';
    document.getElementById('task-id').value = t.id;
    document.getElementById('task-title').value = t.title;
    document.getElementById('task-description').value = t.description || '';
    document.getElementById('task-priority').value = t.priority;
    document.getElementById('task-category').value = t.categoryId || '';
    document.getElementById('task-deadline').value = t.deadline || '';
    document.getElementById('task-status').value = t.status;
    document.getElementById('task-repeat').checked = !!t.repeatMonthly;
    document.getElementById('task-delete').classList.remove('hidden');
  } else {
    document.getElementById('task-modal-title').textContent = 'Новая задача';
    document.getElementById('task-priority').value = 'medium';
    document.getElementById('task-status').value = 'todo';
    document.getElementById('task-delete').classList.add('hidden');
  }

  modal.classList.remove('hidden');
  setTimeout(() => document.getElementById('task-title').focus(), 50);
}

function closeModals() {
  document.getElementById('task-modal').classList.add('hidden');
  document.getElementById('category-modal').classList.add('hidden');
}

async function saveTaskFromForm(e) {
  e.preventDefault();
  const id = document.getElementById('task-id').value;
  const data = {
    title: document.getElementById('task-title').value.trim(),
    description: document.getElementById('task-description').value.trim(),
    priority: document.getElementById('task-priority').value,
    categoryId: document.getElementById('task-category').value || null,
    deadline: document.getElementById('task-deadline').value || '',
    status: document.getElementById('task-status').value,
    repeatMonthly: document.getElementById('task-repeat').checked
  };
  if (!data.title) return;

  closeModals();

  if (id) {
    await updateTask(id, data);
    showToast('Задача обновлена');
  } else {
    await createTask({ ...data, assigneeId: currentUser.id });
  }
}

async function handleDeleteTask() {
  const id = document.getElementById('task-id').value;
  if (!id) return;
  if (!confirm('Удалить задачу безвозвратно?')) return;
  closeModals();
  await deleteTaskRemote(id);
}

function openCategoryModal() {
  const modal = document.getElementById('category-modal');
  document.getElementById('category-form').reset();
  document.getElementById('category-color').value = SWATCH_COLORS[0];
  renderColorGrid(SWATCH_COLORS[0]);
  modal.classList.remove('hidden');
  setTimeout(() => document.getElementById('category-name').focus(), 50);
}

function renderColorGrid(selected) {
  const grid = document.getElementById('color-grid');
  grid.innerHTML = SWATCH_COLORS.map(c => `
    <div class="color-swatch ${c === selected ? 'selected' : ''}"
         data-color="${c}" style="background:${c}"></div>
  `).join('');
  grid.querySelectorAll('.color-swatch').forEach(sw => {
    sw.addEventListener('click', () => {
      document.getElementById('category-color').value = sw.dataset.color;
      grid.querySelectorAll('.color-swatch').forEach(s => s.classList.remove('selected'));
      sw.classList.add('selected');
    });
  });
}

async function saveCategoryFromForm(e) {
  e.preventDefault();
  const name = document.getElementById('category-name').value.trim();
  const color = document.getElementById('category-color').value;
  if (!name) return;
  closeModals();
  await createCategory(name, color);
}

// ============================================================
// ТЕМА
// ============================================================
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem(THEME_KEY, theme);
}

function toggleTheme() {
  const cur = document.documentElement.dataset.theme || 'light';
  applyTheme(cur === 'light' ? 'dark' : 'light');
}

// ============================================================
// УТИЛИТЫ
// ============================================================
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, ch => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[ch]));
}

function hexToSoft(hex) {
  const m = hex.match(/^#([0-9a-f]{6})$/i);
  if (!m) return 'rgba(0,0,0,0.05)';
  const v = m[1];
  const r = parseInt(v.slice(0,2), 16);
  const g = parseInt(v.slice(2,4), 16);
  const b = parseInt(v.slice(4,6), 16);
  return `rgba(${r},${g},${b},0.12)`;
}

let toastTimer = null;
function showToast(text) {
  const t = document.getElementById('toast');
  t.textContent = text;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 2400);
}

function switchTab(tab) {
  activeTab = tab;
  document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.getElementById('board-view').classList.toggle('hidden', tab !== 'board');
  document.getElementById('filters').classList.toggle('hidden', tab !== 'board');
  document.getElementById('archive-view').classList.toggle('hidden', tab !== 'archive');
  if (tab === 'archive') renderArchive();
}

// ============================================================
// СОБЫТИЯ
// ============================================================
function attachGlobalEvents() {
  // вход
  document.getElementById('login-form').addEventListener('submit', async e => {
    e.preventDefault();
    const login = document.getElementById('login-input').value.trim();
    const pass  = document.getElementById('password-input').value;
    const errEl = document.getElementById('login-error');
    errEl.textContent = '';

    const submitBtn = e.target.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Вход…';

    const { user, error } = await tryLogin(login, pass);

    submitBtn.disabled = false;
    submitBtn.textContent = 'Войти';

    if (!user) { errEl.textContent = error || 'Ошибка входа'; return; }
    sessionStorage.setItem(SESSION_KEY, user.id);
    currentUser = user;
    await enterApp();
  });

  // тема
  document.getElementById('theme-toggle').addEventListener('click', toggleTheme);

  // вкладки
  document.querySelectorAll('.tab').forEach(b => {
    b.addEventListener('click', () => switchTab(b.dataset.tab));
  });

  // меню
  const menuToggle = document.getElementById('menu-toggle');
  const menu = document.getElementById('menu');
  menuToggle.addEventListener('click', e => {
    e.stopPropagation();
    menu.classList.toggle('hidden');
  });
  document.addEventListener('click', e => {
    if (!menu.contains(e.target) && e.target !== menuToggle) menu.classList.add('hidden');
  });
  menu.addEventListener('click', e => {
    const action = e.target.dataset.action;
    if (!action) return;
    menu.classList.add('hidden');
    if (action === 'export') exportJson();
    if (action === 'add-category') openCategoryModal();
    if (action === 'logout') logout();
  });

  // кнопка добавления задачи
  document.getElementById('add-task-btn').addEventListener('click', () => openTaskModal());

  // фильтры
  document.getElementById('search-input').addEventListener('input', e => {
    filters.search = e.target.value; renderBoard();
  });
  document.getElementById('filter-mine').addEventListener('change', e => {
    filters.mine = e.target.checked; renderBoard();
  });
  document.getElementById('filter-priority').addEventListener('change', e => {
    filters.priority = e.target.value; renderBoard();
  });
  document.getElementById('filter-category').addEventListener('change', e => {
    filters.category = e.target.value; renderBoard();
  });
  document.getElementById('clear-filters').addEventListener('click', () => {
    filters = { search: '', mine: false, priority: '', category: '' };
    document.getElementById('search-input').value = '';
    document.getElementById('filter-mine').checked = false;
    document.getElementById('filter-priority').value = '';
    document.getElementById('filter-category').value = '';
    renderBoard();
  });

  // модалки
  document.getElementById('task-form').addEventListener('submit', saveTaskFromForm);
  document.getElementById('task-delete').addEventListener('click', handleDeleteTask);
  document.getElementById('category-form').addEventListener('submit', saveCategoryFromForm);
  document.querySelectorAll('[data-close]').forEach(el => {
    el.addEventListener('click', closeModals);
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeModals();
  });

  // архив
  document.getElementById('clear-archive').addEventListener('click', clearArchive);
}

async function enterApp() {
  document.getElementById('login-screen').classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');

  try {
    await loadAllData();
  } catch (e) {
    showToast('Не удалось загрузить данные');
    console.error(e);
    return;
  }

  await runMonthlyMaintenance();
  renderHeader();
  renderFiltersOptions();
  renderBoard();
  subscribeRealtime();
}

// ============================================================
// СТАРТ
// ============================================================
(async function init() {
  applyTheme(localStorage.getItem(THEME_KEY) || 'light');

  if (!initSupabase()) return;

  attachGlobalEvents();

  const ok = await restoreSession();
  if (ok) await enterApp();
})();
