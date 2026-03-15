/* ============================================================
   De'Scribe — Local-first Markdown Notes App
   ============================================================ */

// ===== Profile System =====
const DB_VERSION = 3;
let db;

function getProfiles() {
  try { return JSON.parse(localStorage.getItem('describeProfiles')) || []; }
  catch { return []; }
}

function saveProfiles(profiles) {
  localStorage.setItem('describeProfiles', JSON.stringify(profiles));
}

function getActiveProfileId() {
  return localStorage.getItem('describeActiveProfile') || 'default';
}

function setActiveProfileId(id) {
  localStorage.setItem('describeActiveProfile', id);
}

function ensureDefaultProfile() {
  let profiles = getProfiles();
  if (profiles.length === 0) {
    profiles = [{ id: 'default', name: 'Default' }];
    saveProfiles(profiles);
  }
  if (!profiles.find(p => p.id === getActiveProfileId())) {
    setActiveProfileId(profiles[0].id);
  }
}

function getDBName(profileId) {
  if (!profileId || profileId === 'default') return 'describeDB';
  return 'describeDB_' + profileId;
}

// ===== IndexedDB Wrapper =====
function openDB() {
  const dbName = getDBName(getActiveProfileId());
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(dbName, DB_VERSION);
    req.onupgradeneeded = e => {
      const d = e.target.result;
      if (!d.objectStoreNames.contains('notes'))
        d.createObjectStore('notes', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('folders'))
        d.createObjectStore('folders', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('images'))
        d.createObjectStore('images', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('settings'))
        d.createObjectStore('settings', { keyPath: 'key' });
      if (!d.objectStoreNames.contains('slabs'))
        d.createObjectStore('slabs', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('kanban'))
        d.createObjectStore('kanban', { keyPath: 'id' });
    };
    req.onsuccess = e => { db = e.target.result; resolve(db); };
    req.onerror = e => reject(e.target.error);
  });
}

function openDBForProfile(profileId) {
  const dbName = getDBName(profileId);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(dbName, DB_VERSION);
    req.onupgradeneeded = e => {
      const d = e.target.result;
      if (!d.objectStoreNames.contains('notes')) d.createObjectStore('notes', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('folders')) d.createObjectStore('folders', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('images')) d.createObjectStore('images', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('settings')) d.createObjectStore('settings', { keyPath: 'key' });
      if (!d.objectStoreNames.contains('slabs')) d.createObjectStore('slabs', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('kanban')) d.createObjectStore('kanban', { keyPath: 'id' });
    };
    req.onsuccess = e => resolve(e.target.result);
    req.onerror = e => reject(e.target.error);
  });
}

function dbPut(store, item) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).put(item);
    tx.oncomplete = () => resolve();
    tx.onerror = e => reject(e.target.error);
  });
}

function dbGet(store, key) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = e => reject(e.target.error);
  });
}

function dbGetAll(store) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = e => reject(e.target.error);
  });
}

function dbDelete(store, key) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = e => reject(e.target.error);
  });
}

function dbClearStore(storeName) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = e => reject(e.target.error);
  });
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// ===== State =====
let allNotes = [];
let allFolders = [];
let currentNote = null;
let saveTimeout = null;
let activeTagFilter = null;
let sessionStartWords = 0;
let richMode = false;
let richSyncTimeout = null;

// ===== Undo / Redo (last 3 changes) =====
// Per-note history: Map<noteId, { stack: string[], pointer: number }>
const undoHistories = new Map();
const UNDO_MAX = 4; // current + 3 undoable states

function getUndoHistory(noteId) {
  if (!undoHistories.has(noteId)) {
    undoHistories.set(noteId, { stack: [], pointer: -1 });
  }
  return undoHistories.get(noteId);
}

function undoPushState(noteId, content) {
  const h = getUndoHistory(noteId);
  // If pointer isn't at end, discard redo states
  if (h.pointer < h.stack.length - 1) {
    h.stack = h.stack.slice(0, h.pointer + 1);
  }
  // Don't push duplicate
  if (h.stack.length > 0 && h.stack[h.stack.length - 1] === content) return;
  h.stack.push(content);
  // Trim to max
  if (h.stack.length > UNDO_MAX) {
    h.stack.shift();
  }
  h.pointer = h.stack.length - 1;
}

function undoApply(noteId, direction) {
  const h = getUndoHistory(noteId);
  if (h.stack.length === 0) return null;
  const newPointer = h.pointer + direction;
  if (newPointer < 0 || newPointer >= h.stack.length) return null;
  h.pointer = newPointer;
  return h.stack[h.pointer];
}

// ===== DOM refs =====
const $sidebar = document.getElementById('sidebar');
const $tree = document.getElementById('file-tree');
const $editor = document.getElementById('editor');
const $preview = document.getElementById('preview');
const $editorContainer = document.getElementById('editor-container');
const $editorArea = document.getElementById('editor-area');
const $statusMsg = document.getElementById('status-msg');
const $wordCount = document.getElementById('word-count');
const $emptyState = document.getElementById('empty-state');
const $searchInput = document.getElementById('header-search-input');
const $searchDropdown = document.getElementById('header-search-dropdown');
const $exportModal = document.getElementById('export-modal');
const $contextMenu = document.getElementById('context-menu');
const $saveDot = document.getElementById('save-dot');
const $tagBar = document.getElementById('tag-bar');
const $tagChips = document.getElementById('tag-chips');
const $tagInput = document.getElementById('tag-input');
const $tagAutocomplete = document.getElementById('tag-autocomplete');
const $tagFilterBar = document.getElementById('tag-filter-bar');
const $tagFilterWrapper = document.getElementById('tag-filter-wrapper');
const $tagFilterHeader = document.getElementById('tag-filter-header');

$tagFilterHeader.addEventListener('click', () => {
  $tagFilterHeader.classList.toggle('expanded');
  $tagFilterBar.classList.toggle('collapsed');
});
const $pinnedNotes = document.getElementById('pinned-notes');
const $pinnedList = document.getElementById('pinned-list');
const $templateDrawer = document.getElementById('template-drawer');
const $templateHeader = document.getElementById('template-header');
const $templateList = document.getElementById('template-list');

const TEMPLATES = [
  {
    id: 'character-sheet',
    name: 'Character Sheet',
    icon: '\uD83E\uDDCD',
    tags: ['character', 'worldbuilding'],
    title: 'New Character',
    content: `# Character Name

## Basic Info
| Attribute | Detail |
|---|---|
| **Full Name** | |
| **Nickname(s)** | |
| **Age** | |
| **Gender** | |
| **Species/Race** | |
| **Occupation** | |

## Appearance
| Attribute | Detail |
|---|---|
| **Height** | |
| **Weight/Build** | |
| **Hair** | |
| **Eyes** | |
| **Skin** | |
| **Distinguishing Features** | |

## Personality
| Trait | Detail |
|---|---|
| **Positive Traits** | |
| **Negative Traits** | |
| **Fears** | |
| **Motivations** | |
| **Habits/Quirks** | |

## Background
### Backstory
> Write a brief history...

### Key Relationships
- **Family:**
- **Friends:**
- **Rivals/Enemies:**

## Skills & Abilities
-
-
-

## Equipment / Possessions
-
-
-

## Notes
> Additional details, arc ideas, story role...`
  },
  {
    id: 'budget',
    name: 'Budget Planner',
    icon: '\uD83D\uDCB0',
    tags: ['budget', 'finance'],
    title: 'New Budget',
    content: `<!-- budget -->
# Budget Planner

## Income
| Source | Monthly Amount |
|---|---|
| Salary | 0 |
| Freelance | 0 |
| Investments | 0 |
| Side Hustle | 0 |
| Other | 0 |

## Fixed Expenses
| Category | Monthly Amount |
|---|---|
| Rent/Mortgage | 0 |
| Utilities | 0 |
| Insurance | 0 |
| Subscriptions | 0 |
| Loan Payments | 0 |
| Phone/Internet | 0 |

## Variable Expenses
| Category | Monthly Amount |
|---|---|
| Groceries | 0 |
| Dining Out | 0 |
| Transportation | 0 |
| Entertainment | 0 |
| Shopping | 0 |
| Health/Fitness | 0 |
| Personal Care | 0 |
| Miscellaneous | 0 |

## Savings & Goals
| Goal | Monthly Contribution |
|---|---|
| Emergency Fund | 0 |
| Retirement | 0 |
| Vacation | 0 |
| Other Savings | 0 |

## Projections
> The charts below are generated automatically from your tables above. Edit the amounts and switch between preview modes to see updated graphs.

## Notes
> Track anomalies, upcoming changes, or financial goals here...`
  }
];

$templateHeader.addEventListener('click', () => {
  $templateHeader.classList.toggle('expanded');
  $templateList.classList.toggle('collapsed');
});

function renderTemplates() {
  $templateList.innerHTML = '';
  TEMPLATES.forEach(tmpl => {
    const div = document.createElement('div');
    div.className = 'template-item';
    div.draggable = true;

    const icon = document.createElement('span');
    icon.className = 'template-item-icon';
    icon.textContent = tmpl.icon;

    const label = document.createElement('span');
    label.textContent = tmpl.name;

    div.append(icon, label);

    div.addEventListener('dragstart', e => {
      dragItem = { type: 'template', id: tmpl.id };
      e.dataTransfer.effectAllowed = 'copy';
      e.dataTransfer.setData('text/plain', JSON.stringify(dragItem));
    });

    div.addEventListener('click', async () => {
      const note = await createNoteFromTemplate(tmpl.id, null);
      if (note) openNote(note.id);
    });

    $templateList.appendChild(div);
  });
}

async function createNoteFromTemplate(templateId, folderId) {
  const tmpl = TEMPLATES.find(t => t.id === templateId);
  if (!tmpl) return null;
  const note = {
    id: uid(),
    folderId: folderId || null,
    title: tmpl.title,
    content: tmpl.content,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    sortOrder: allNotes.length,
    tags: [...(tmpl.tags || [])]
  };
  await dbPut('notes', note);
  allNotes.push(note);
  renderTree();
  return note;
}
const $wordGoalBar = document.getElementById('word-goal-bar');
const $wordCountWrapper = document.getElementById('word-count-wrapper');
const $folderColorPicker = document.getElementById('folder-color-picker');

// ===== Auto-Save Indicator (Feature 1) =====
let saveDotTimer = null;

function setSaveStatus(state) {
  $saveDot.className = '';
  if (state === 'typing') {
    $saveDot.classList.add('typing');
    $statusMsg.textContent = 'Typing...';
  } else if (state === 'saving') {
    $saveDot.classList.add('saving');
    $statusMsg.textContent = 'Saving...';
  } else if (state === 'saved') {
    $saveDot.classList.add('saved');
    $statusMsg.textContent = 'Saved';
    clearTimeout(saveDotTimer);
    saveDotTimer = setTimeout(() => {
      $saveDot.className = '';
      $statusMsg.textContent = 'Ready';
    }, 2500);
  } else {
    $statusMsg.textContent = 'Ready';
  }
}

// ===== Markdown Setup =====
marked.setOptions({
  breaks: true,
  gfm: true,
  highlight: (code, lang) => {
    if (lang && hljs.getLanguage(lang)) {
      return hljs.highlight(code, { language: lang }).value;
    }
    return hljs.highlightAuto(code).value;
  }
});

// ===== Init =====
async function init() {
  ensureDefaultProfile();
  renderProfileSwitcher();
  await openDB();
  allNotes = await dbGetAll('notes');
  allFolders = await dbGetAll('folders');

  const theme = await dbGet('settings', 'theme');
  if (theme) document.documentElement.setAttribute('data-theme', theme.value);

  const sidebarWidth = await dbGet('settings', 'sidebarWidth');
  if (sidebarWidth) $sidebar.style.width = sidebarWidth.value + 'px';

  renderTree();
  renderTemplates();
  setEditorState(false);

  const lastNote = await dbGet('settings', 'lastNote');
  if (lastNote) {
    const note = allNotes.find(n => n.id === lastNote.value);
    if (note) openNote(note.id);
  }

  const lastView = await dbGet('settings', 'viewMode');
  if (lastView) setViewMode(lastView.value);

  const viewport = await dbGet('settings', 'viewport');
  if (viewport && viewport.value === 'mobile') {
    document.documentElement.setAttribute('data-viewport', 'mobile');
    document.getElementById('viewport-btn').innerHTML = '&#128421;';
    setViewportMeta(true);
    setViewMode('view-rich');
  }

  await loadSlabs();
  allKanbanBoards = await dbGetAll('kanban') || [];

  setupEventListeners();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
}

// ===== File Tree Rendering =====
function renderTree() {
  const folders = allFolders.sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));
  const notes = allNotes.sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));

  const slabs = allSlabBoards.sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));

  // Filter notes by active tag if set
  const filteredNoteIds = activeTagFilter
    ? new Set(allNotes.filter(n => !n.deleted && (n.tags || []).includes(activeTagFilter)).map(n => n.id))
    : null;

  function buildLevel(parentId) {
    const ul = document.createElement('ul');
    const childFolders = folders.filter(f => (f.parentId || null) === parentId);
    let childNotes = notes.filter(n => (n.folderId || null) === parentId && !n.deleted);
    if (filteredNoteIds) childNotes = childNotes.filter(n => filteredNoteIds.has(n.id));
    const childSlabs = slabs.filter(b => (b.folderId || null) === parentId);
    const childKanbans = allKanbanBoards.filter(b => (b.folderId || null) === parentId);

    childFolders.forEach(folder => {
      const li = document.createElement('li');

      const div = document.createElement('div');
      div.className = 'tree-item';
      div.dataset.type = 'folder';
      div.dataset.id = folder.id;
      div.draggable = true;
      if (folder.color) div.style.borderLeft = '3px solid ' + folder.color;

      const arrow = document.createElement('span');
      arrow.className = 'tree-folder-icon' + (folder.collapsed ? ' collapsed' : '');
      arrow.textContent = '\u25BC';

      const icon = document.createElement('span');
      icon.className = 'tree-item-icon';
      icon.textContent = '\uD83D\uDCC1';

      const label = document.createElement('span');
      label.className = 'tree-item-label';
      label.textContent = folder.name;

      div.append(arrow, icon, label);
      li.appendChild(div);

      const children = document.createElement('div');
      children.className = 'tree-children' + (folder.collapsed ? ' collapsed' : '');
      children.appendChild(buildLevel(folder.id));
      li.appendChild(children);

      ul.appendChild(li);
    });

    childKanbans.forEach(board => {
      const li = document.createElement('li');
      const div = document.createElement('div');
      const isActiveKanban = !$kanbanView.classList.contains('hidden') && currentKanbanId === board.id;
      div.className = 'tree-item' + (isActiveKanban ? ' active' : '');
      div.dataset.type = 'kanban';
      div.dataset.id = board.id;
      div.draggable = true;

      const spacer = document.createElement('span');
      spacer.style.width = '14px';
      spacer.style.flexShrink = '0';

      const icon = document.createElement('span');
      icon.className = 'tree-item-icon';
      icon.textContent = '\u2610';

      const label = document.createElement('span');
      label.className = 'tree-item-label';
      label.textContent = board.name;

      div.append(spacer, icon, label);
      li.appendChild(div);
      ul.appendChild(li);
    });

    childSlabs.forEach(board => {
      const li = document.createElement('li');
      const div = document.createElement('div');
      const isActiveSlab = !$neuralSlab.classList.contains('hidden') && currentSlabId === board.id;
      div.className = 'tree-item' + (isActiveSlab ? ' active' : '');
      div.dataset.type = 'slab';
      div.dataset.id = board.id;
      div.draggable = true;

      const spacer = document.createElement('span');
      spacer.style.width = '14px';
      spacer.style.flexShrink = '0';

      const icon = document.createElement('span');
      icon.className = 'tree-item-icon';
      icon.textContent = '\uD83E\uDDE0';

      const label = document.createElement('span');
      label.className = 'tree-item-label';
      label.textContent = board.name;

      div.append(spacer, icon, label);
      li.appendChild(div);
      ul.appendChild(li);
    });

    childNotes.forEach(note => {
      const li = document.createElement('li');
      const div = document.createElement('div');
      div.className = 'tree-item' + (currentNote && currentNote.id === note.id ? ' active' : '');
      div.dataset.type = 'note';
      div.dataset.id = note.id;
      div.draggable = true;

      const spacer = document.createElement('span');
      spacer.style.width = '14px';
      spacer.style.flexShrink = '0';

      const icon = document.createElement('span');
      icon.className = 'tree-item-icon';
      icon.textContent = '\uD83D\uDCC4';

      const label = document.createElement('span');
      label.className = 'tree-item-label';
      label.textContent = note.title;

      div.append(spacer, icon, label);

      // Pin badge if pinned
      if (note.pinned) {
        const badge = document.createElement('span');
        badge.className = 'pin-badge';
        badge.textContent = '\uD83D\uDCCC';
        div.appendChild(badge);
      }

      li.appendChild(div);
      ul.appendChild(li);
    });

    return ul;
  }

  $tree.innerHTML = '';
  $tree.appendChild(buildLevel(null));

  // Render pinned notes
  renderPinnedNotes();

  // Render tag filter bar
  renderTagFilterBar();
}

// ===== Pinned Notes (Feature 2) =====
function renderPinnedNotes() {
  const pinned = allNotes
    .filter(n => n.pinned && !n.deleted)
    .sort((a, b) => (a.pinnedAt || 0) - (b.pinnedAt || 0));

  if (pinned.length === 0) {
    $pinnedNotes.classList.add('hidden');
    return;
  }

  $pinnedNotes.classList.remove('hidden');
  $pinnedList.innerHTML = '';

  pinned.forEach(note => {
    const li = document.createElement('li');
    const div = document.createElement('div');
    div.className = 'tree-item' + (currentNote && currentNote.id === note.id ? ' active' : '');
    div.dataset.type = 'note';
    div.dataset.id = note.id;

    const icon = document.createElement('span');
    icon.className = 'tree-item-icon';
    icon.textContent = '\uD83D\uDCCC';

    const label = document.createElement('span');
    label.className = 'tree-item-label';
    label.textContent = note.title;

    div.append(icon, label);
    div.addEventListener('click', () => openNote(note.id));
    div.addEventListener('contextmenu', e => {
      e.preventDefault();
      showContextMenu(e.clientX, e.clientY, 'note', note.id);
    });
    li.appendChild(div);
    $pinnedList.appendChild(li);
  });
}

// ===== Tree Interactions =====
let treeClickTimer = null;
let renamingInProgress = false;

$tree.addEventListener('click', async e => {
  const item = e.target.closest('.tree-item');
  if (!item) return;

  if (item.querySelector('input') || renamingInProgress) return;

  const { type, id } = item.dataset;

  // Delay single-click action to let dblclick cancel it
  if (treeClickTimer) clearTimeout(treeClickTimer);
  treeClickTimer = setTimeout(async () => {
    treeClickTimer = null;
    if (renamingInProgress) return;
    if (type === 'folder') {
      const folder = allFolders.find(f => f.id === id);
      if (folder) {
        folder.collapsed = !folder.collapsed;
        await dbPut('folders', folder);
        renderTree();
      }
    } else if (type === 'note') {
      if (!$neuralSlab.classList.contains('hidden')) closeSlabView();
      openNote(id);
    } else if (type === 'slab') {
      openSlabView(id);
    } else if (type === 'kanban') {
      openKanbanView(id);
    }
  }, 250);
});

$tree.addEventListener('contextmenu', e => {
  const item = e.target.closest('.tree-item');
  if (!item) return;
  e.preventDefault();
  showContextMenu(e.clientX, e.clientY, item.dataset.type, item.dataset.id);
});

function startInlineRename(type, id) {
  const el = $tree.querySelector(`[data-id="${id}"] .tree-item-label`);
  if (!el || el.querySelector('input')) return;
  renamingInProgress = true;
  const oldName = el.textContent;
  el.innerHTML = '';
  const input = document.createElement('input');
  input.value = oldName;
  el.appendChild(input);
  input.focus();
  input.select();

  let finished = false;
  const finish = async () => {
    if (finished) return;
    finished = true;
    const newName = input.value.trim() || oldName;
    if (type === 'folder') {
      const folder = allFolders.find(f => f.id === id);
      if (folder) { folder.name = newName; await dbPut('folders', folder); }
    } else if (type === 'slab') {
      const board = allSlabBoards.find(b => b.id === id);
      if (board) { board.name = newName; await dbPut('slabs', board); }
    } else if (type === 'kanban') {
      const board = allKanbanBoards.find(b => b.id === id);
      if (board) { board.name = newName; await dbPut('kanban', board); if (currentKanbanId === id) document.getElementById('kanban-toolbar-name').textContent = '\u2610 ' + newName; }
    } else {
      const note = allNotes.find(n => n.id === id);
      if (note) { note.title = newName; await dbPut('notes', note); if (currentNote && currentNote.id === id) $noteTitleInput.value = newName; }
    }
    renamingInProgress = false;
    renderTree();
  };

  input.addEventListener('blur', finish);
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') input.blur();
    if (e.key === 'Escape') { input.value = oldName; input.blur(); }
  });
  // Prevent clicks inside the input from triggering tree click
  input.addEventListener('click', e => e.stopPropagation());
}

$tree.addEventListener('dblclick', e => {
  const item = e.target.closest('.tree-item');
  if (!item) return;
  e.preventDefault();
  e.stopPropagation();
  if (treeClickTimer) { clearTimeout(treeClickTimer); treeClickTimer = null; }
  startInlineRename(item.dataset.type, item.dataset.id);
});

// ===== Drag & Drop Reorder =====
let dragItem = null;

$tree.addEventListener('dragstart', e => {
  const item = e.target.closest('.tree-item');
  if (!item) return;
  dragItem = { type: item.dataset.type, id: item.dataset.id };
  item.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'copyMove';
  // Store note info in dataTransfer so the slab canvas can read it
  e.dataTransfer.setData('text/plain', JSON.stringify(dragItem));
});

$tree.addEventListener('dragover', e => {
  e.preventDefault();
  const item = e.target.closest('.tree-item');
  if (item) item.classList.add('drag-over');
});

$tree.addEventListener('dragleave', e => {
  const item = e.target.closest('.tree-item');
  if (item) item.classList.remove('drag-over');
});

$tree.addEventListener('drop', async e => {
  e.preventDefault();
  document.querySelectorAll('.drag-over, .dragging').forEach(el => {
    el.classList.remove('drag-over', 'dragging');
  });

  if (!dragItem) return;
  const target = e.target.closest('.tree-item');

  // Drop onto empty tree area => move to root
  if (!target) {
    if (dragItem.type === 'note') {
      const note = allNotes.find(n => n.id === dragItem.id);
      if (note) { note.folderId = null; await dbPut('notes', note); }
    } else if (dragItem.type === 'slab') {
      const board = allSlabBoards.find(b => b.id === dragItem.id);
      if (board) { board.folderId = null; await dbPut('slabs', board); }
    } else if (dragItem.type === 'kanban') {
      const board = allKanbanBoards.find(b => b.id === dragItem.id);
      if (board) { board.folderId = null; await dbPut('kanban', board); }
    } else if (dragItem.type === 'folder') {
      const folder = allFolders.find(f => f.id === dragItem.id);
      if (folder) { folder.parentId = null; await dbPut('folders', folder); }
    } else if (dragItem.type === 'template') {
      const note = await createNoteFromTemplate(dragItem.id, null);
      if (note) openNote(note.id);
    }
    dragItem = null;
    renderTree();
    return;
  }

  const targetType = target.dataset.type;
  const targetId = target.dataset.id;

  // Drop note/folder/slab onto a folder => move inside
  if (targetType === 'folder' && dragItem.id !== targetId) {
    if (dragItem.type === 'note') {
      const note = allNotes.find(n => n.id === dragItem.id);
      if (note) { note.folderId = targetId; await dbPut('notes', note); }
    } else if (dragItem.type === 'slab') {
      const board = allSlabBoards.find(b => b.id === dragItem.id);
      if (board) { board.folderId = targetId; await dbPut('slabs', board); }
    } else if (dragItem.type === 'kanban') {
      const board = allKanbanBoards.find(b => b.id === dragItem.id);
      if (board) { board.folderId = targetId; await dbPut('kanban', board); }
    } else if (dragItem.type === 'template') {
      const note = await createNoteFromTemplate(dragItem.id, targetId);
      if (note) openNote(note.id);
    } else {
      const folder = allFolders.find(f => f.id === dragItem.id);
      if (folder && targetId !== folder.id) {
        folder.parentId = targetId;
        await dbPut('folders', folder);
      }
    }
    renderTree();
  }
  // Drop note onto note => reorder (same parent)
  else if (targetType === 'note' && dragItem.type === 'note' && dragItem.id !== targetId) {
    const dragNote = allNotes.find(n => n.id === dragItem.id);
    const targetNote = allNotes.find(n => n.id === targetId);
    if (dragNote && targetNote) {
      dragNote.folderId = targetNote.folderId;
      const siblings = allNotes
        .filter(n => (n.folderId || null) === (targetNote.folderId || null))
        .sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));
      const idx = siblings.indexOf(targetNote);
      siblings.splice(siblings.indexOf(dragNote), 1);
      siblings.splice(idx, 0, dragNote);
      for (let i = 0; i < siblings.length; i++) {
        siblings[i].sortOrder = i;
        await dbPut('notes', siblings[i]);
      }
      renderTree();
    }
  }

  dragItem = null;
});

$tree.addEventListener('dragend', () => {
  document.querySelectorAll('.drag-over, .dragging').forEach(el => {
    el.classList.remove('drag-over', 'dragging');
  });
  // Don't null dragItem here — the slab canvas drop handler may still need it
  setTimeout(() => { dragItem = null; }, 100);
});

// ===== Context Menu =====
let ctxTarget = { type: null, id: null };

function showContextMenu(x, y, type, id) {
  ctxTarget = { type, id };
  $contextMenu.style.left = x + 'px';
  $contextMenu.style.top = y + 'px';
  document.getElementById('ctx-new-note').style.display = type === 'folder' ? '' : 'none';
  document.getElementById('ctx-new-subfolder').style.display = type === 'folder' ? '' : 'none';

  // Pin option: only for notes
  const pinBtn = document.getElementById('ctx-pin');
  if (type === 'note') {
    pinBtn.style.display = '';
    const note = allNotes.find(n => n.id === id);
    pinBtn.innerHTML = note && note.pinned ? '&#128204; Unpin' : '&#128204; Pin';
  } else {
    pinBtn.style.display = 'none';
  }

  // Color option: only for folders
  document.getElementById('ctx-color').style.display = type === 'folder' ? '' : 'none';

  $contextMenu.classList.remove('hidden');
}

function hideContextMenu() {
  $contextMenu.classList.add('hidden');
}

document.addEventListener('click', hideContextMenu);

$contextMenu.addEventListener('click', async e => {
  const btn = e.target.closest('[data-ctx]');
  if (!btn) return;
  const action = btn.dataset.ctx;

  if (action === 'new-note') {
    const note = {
      id: uid(),
      folderId: ctxTarget.id,
      title: 'Untitled',
      content: '',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      sortOrder: allNotes.length
    };
    await dbPut('notes', note);
    allNotes.push(note);
    // Expand the folder
    const folder = allFolders.find(f => f.id === ctxTarget.id);
    if (folder && folder.collapsed) { folder.collapsed = false; await dbPut('folders', folder); }
    renderTree();
    openNote(note.id);
    startInlineRename('note', note.id);
  }

  if (action === 'new-subfolder') {
    const subfolder = {
      id: uid(),
      parentId: ctxTarget.id,
      name: 'New Folder',
      sortOrder: allFolders.length,
      collapsed: false
    };
    await dbPut('folders', subfolder);
    allFolders.push(subfolder);
    // Expand the parent folder
    const parent = allFolders.find(f => f.id === ctxTarget.id);
    if (parent && parent.collapsed) { parent.collapsed = false; await dbPut('folders', parent); }
    renderTree();
    startInlineRename('folder', subfolder.id);
  }

  if (action === 'pin') {
    const note = allNotes.find(n => n.id === ctxTarget.id);
    if (note) {
      note.pinned = !note.pinned;
      note.pinnedAt = note.pinned ? Date.now() : null;
      await dbPut('notes', note);
      renderTree();
    }
  }

  if (action === 'color') {
    showFolderColorPicker(ctxTarget.id);
  }

  if (action === 'rename') {
    startInlineRename(ctxTarget.type, ctxTarget.id);
  }

  if (action === 'delete') {
    let name;
    if (ctxTarget.type === 'folder') name = allFolders.find(f => f.id === ctxTarget.id)?.name;
    else if (ctxTarget.type === 'slab') name = allSlabBoards.find(b => b.id === ctxTarget.id)?.name;
    else if (ctxTarget.type === 'kanban') name = allKanbanBoards.find(b => b.id === ctxTarget.id)?.name;
    else name = allNotes.find(n => n.id === ctxTarget.id)?.title;
    if (!confirm(`Delete "${name}"?`)) return;

    if (ctxTarget.type === 'folder') {
      await deleteFolder(ctxTarget.id);
    } else if (ctxTarget.type === 'slab') {
      allSlabBoards = allSlabBoards.filter(b => b.id !== ctxTarget.id);
      await dbDelete('slabs', ctxTarget.id);
      if (currentSlabId === ctxTarget.id) {
        if (allSlabBoards.length > 0) {
          openSlabView(allSlabBoards[0].id);
        } else {
          closeSlabView();
          currentSlabId = null;
        }
      }
    } else if (ctxTarget.type === 'kanban') {
      allKanbanBoards = allKanbanBoards.filter(b => b.id !== ctxTarget.id);
      await dbDelete('kanban', ctxTarget.id);
      if (currentKanbanId === ctxTarget.id) {
        closeKanbanView();
        currentKanbanId = null;
      }
    } else {
      await deleteNote(ctxTarget.id);
    }
    renderTree();
    renderBranchPanel();
  }

  hideContextMenu();
});

async function deleteFolder(folderId) {
  // Recursively delete child folders and notes
  const childFolders = allFolders.filter(f => f.parentId === folderId);
  for (const cf of childFolders) await deleteFolder(cf.id);

  const childNotes = allNotes.filter(n => n.folderId === folderId);
  for (const cn of childNotes) await deleteNote(cn.id);

  allFolders = allFolders.filter(f => f.id !== folderId);
  await dbDelete('folders', folderId);
}

async function deleteNote(noteId) {
  const note = allNotes.find(n => n.id === noteId);

  // Check if this note is part of a branch family
  const isBranchNote = note && note.branchFrom;
  const hasBranchChildren = allNotes.some(n => n.branchFrom === noteId);
  const isPartOfFamily = isBranchNote || hasBranchChildren;

  if (isPartOfFamily) {
    // Soft delete — keep in allNotes for branch map but mark as deleted
    if (note) {
      note.deleted = true;
      note.updatedAt = Date.now();
      await dbPut('notes', note);
    }
  } else {
    // Hard delete
    const images = await dbGetAll('images');
    for (const img of images.filter(i => i.noteId === noteId)) {
      await dbDelete('images', img.id);
    }
    allNotes = allNotes.filter(n => n.id !== noteId);
    await dbDelete('notes', noteId);
  }

  if (currentNote && currentNote.id === noteId) {
    currentNote = null;
    setEditorState(false);
  }
}

// ===== Note CRUD =====
document.getElementById('new-note-btn').addEventListener('click', async () => {
  const note = {
    id: uid(),
    folderId: null,
    title: 'Untitled',
    content: '',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    sortOrder: allNotes.length
  };
  await dbPut('notes', note);
  allNotes.push(note);
  renderTree();
  openNote(note.id);
});

document.getElementById('new-folder-btn').addEventListener('click', async () => {
  const folder = {
    id: uid(),
    parentId: null,
    name: 'New Folder',
    sortOrder: allFolders.length,
    collapsed: false
  };
  await dbPut('folders', folder);
  allFolders.push(folder);
  renderTree();
});

// ===== Brain Dump =====
const $braindumpModal = document.getElementById('braindump-modal');
const $braindumpEditor = document.getElementById('braindump-editor');
const $braindumpPreview = document.getElementById('braindump-preview');

document.getElementById('brain-dump-btn').addEventListener('click', () => {
  $braindumpEditor.value = '';
  $braindumpPreview.innerHTML = '';
  $braindumpModal.classList.remove('hidden');
  $braindumpEditor.focus();
});

document.getElementById('braindump-close').addEventListener('click', () => {
  $braindumpModal.classList.add('hidden');
});

document.getElementById('braindump-cancel').addEventListener('click', () => {
  $braindumpModal.classList.add('hidden');
});

$braindumpModal.addEventListener('click', e => {
  if (e.target === $braindumpModal) $braindumpModal.classList.add('hidden');
});

function parseBrainDump(text) {
  const lines = text.split('\n');
  const groups = [];
  let currentGroup = { folder: null, notes: [] }; // ungrouped notes at top

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    if (/^#+\s+/.test(line)) {
      // New folder heading
      const folderName = line.replace(/^#+\s+/, '').trim();
      if (folderName) {
        currentGroup = { folder: folderName, notes: [] };
        groups.push(currentGroup);
      }
    } else {
      if (!groups.length || currentGroup.folder === null) {
        // No folder yet, push to ungrouped
        if (!groups.length || groups[0].folder !== null) {
          const ungrouped = { folder: null, notes: [] };
          groups.unshift(ungrouped);
          currentGroup = ungrouped;
        } else {
          currentGroup = groups[0];
        }
      }
      currentGroup.notes.push(line);
    }
  }

  return groups.filter(g => g.notes.length > 0);
}

// Live preview as user types
$braindumpEditor.addEventListener('input', () => {
  const groups = parseBrainDump($braindumpEditor.value);
  if (!groups.length) {
    $braindumpPreview.innerHTML = '';
    return;
  }

  $braindumpPreview.innerHTML = groups.map(g => {
    const folderLabel = g.folder
      ? `\uD83D\uDCC1 ${g.folder}`
      : '\uD83D\uDCC4 Unsorted';
    const chips = g.notes.map(n =>
      `<span class="braindump-note-chip">${n.length > 40 ? n.slice(0, 40) + '...' : n}</span>`
    ).join('');
    return `<div class="braindump-group">
      <div class="braindump-group-title">${folderLabel} <span style="color:var(--text-muted);font-weight:400">(${g.notes.length})</span></div>
      <div class="braindump-group-notes">${chips}</div>
    </div>`;
  }).join('');
});

// Sort & Create
document.getElementById('braindump-sort').addEventListener('click', async () => {
  const groups = parseBrainDump($braindumpEditor.value);
  if (!groups.length) return;

  let lastNoteId = null;

  for (const group of groups) {
    let folderId = null;

    if (group.folder) {
      // Find existing folder or create new one
      let folder = allFolders.find(f => f.name.toLowerCase() === group.folder.toLowerCase());
      if (!folder) {
        folder = {
          id: uid(),
          parentId: null,
          name: group.folder,
          sortOrder: allFolders.length,
          collapsed: false
        };
        await dbPut('folders', folder);
        allFolders.push(folder);
      }
      folderId = folder.id;
    }

    for (const noteText of group.notes) {
      const note = {
        id: uid(),
        folderId: folderId,
        title: noteText.slice(0, 60),
        content: noteText,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        sortOrder: allNotes.length
      };
      await dbPut('notes', note);
      allNotes.push(note);
      lastNoteId = note.id;
    }
  }

  $braindumpModal.classList.add('hidden');
  renderTree();
  if (lastNoteId) openNote(lastNoteId);
});

const $noteTitleBar = document.getElementById('note-title-bar');
const $noteTitleInput = document.getElementById('note-title-input');

function openNote(id) {
  const note = allNotes.find(n => n.id === id);
  if (!note) return;

  // Close venn view if open
  if (!$vennView.classList.contains('hidden')) closeVennView();
  if (!$kanbanView.classList.contains('hidden')) closeKanbanView();

  // If exiting rich mode, sync first
  if (richMode && currentNote) syncRichToMarkdown();
  richMode = false;
  $preview.contentEditable = 'false';
  $preview.classList.remove('rich-editable');

  currentNote = note;
  $editor.value = note.content;
  $noteTitleInput.value = note.title;
  $noteTitleBar.classList.remove('hidden');

  // Seed undo history with current content
  undoPushState(note.id, note.content);

  // Track session start words for word goal
  const text = note.content.trim();
  sessionStartWords = text ? text.split(/\s+/).length : 0;

  updatePreview();
  updateWordCount();
  updateEditorBranchMarkers();
  updateEditorHighlight();
  updateMinimapContent();
  setEditorState(true);
  renderTree();
  renderBranchPanel();
  renderTagBar();
  dbPut('settings', { key: 'lastNote', value: id });
}

$noteTitleInput.addEventListener('input', async () => {
  if (!currentNote) return;
  const newTitle = $noteTitleInput.value.trim() || 'Untitled';
  currentNote.title = newTitle;
  currentNote.updatedAt = Date.now();
  setSaveStatus('typing');
  clearTimeout(saveTimeout);
  saveTimeout = setTimeout(async () => {
    setSaveStatus('saving');
    await dbPut('notes', currentNote);
    setSaveStatus('saved');
  }, 400);
  renderTree();
});

// Branch marker line inserted into editor text
const BRANCH_MARKER_PREFIX = '── ⑂ ';

function updateEditorBranchMarkers() {
  if (!currentNote) return;

  // Strip any existing marker lines from content
  const cleaned = stripBranchMarkers(currentNote.content);
  if (cleaned !== currentNote.content) {
    currentNote.content = cleaned;
  }

  // Collect markers to insert
  const markers = [];

  // For the original note: show flags where child BAs forked
  const childBranches = allNotes
    .filter(n => n.branchFrom === currentNote.id && n.branchAt != null)
    .sort((a, b) => (a.branchAt || 0) - (b.branchAt || 0));

  for (const child of childBranches) {
    markers.push({ pos: child.branchAt, label: child.title });
  }

  // For a BA note: show a marker at the end
  if (currentNote.branchFrom) {
    const parent = allNotes.find(n => n.id === currentNote.branchFrom);
    if (parent) {
      markers.push({ pos: currentNote.content.length, label: 'Branched from: ' + parent.title });
    }
  }

  if (markers.length === 0) {
    $editor.value = currentNote.content;
    return;
  }

  // Insert marker lines into the display text (from end to start)
  let display = currentNote.content;
  markers.sort((a, b) => b.pos - a.pos);
  for (const m of markers) {
    const pos = Math.min(m.pos, display.length);
    const markerLine = '\n' + BRANCH_MARKER_PREFIX + m.label + '\n';
    display = display.slice(0, pos) + markerLine + display.slice(pos);
  }

  $editor.value = display;
}

function stripBranchMarkers(text) {
  // Remove marker lines so they don't get saved
  return text.replace(/\n?── ⑂ [^\n]*\n?/g, '');
}

// Override input handler to strip markers before saving
const originalInputHandler = true; // flag that markers exist

function setEditorState(hasNote) {
  if (hasNote) {
    $editorArea.classList.remove('no-note');
    $emptyState.classList.add('hidden');
  } else {
    $editorArea.classList.add('no-note');
    $emptyState.classList.remove('hidden');
    $editor.value = '';
    $preview.innerHTML = '';
    $branchPanel.classList.add('hidden');
    $noteTitleBar.classList.add('hidden');
    $tagBar.classList.add('hidden');
  }
}

// ===== Editor =====
$editor.addEventListener('input', () => {
  if (!currentNote) return;
  // Strip branch markers before saving
  currentNote.content = stripBranchMarkers($editor.value);
  currentNote.updatedAt = Date.now();

  updatePreview();
  updateWordCount();
  updateEditorHighlight();
  setSaveStatus('typing');

  clearTimeout(saveTimeout);
  saveTimeout = setTimeout(async () => {
    setSaveStatus('saving');
    await dbPut('notes', currentNote);
    undoPushState(currentNote.id, currentNote.content);
    setSaveStatus('saved');
    renderTree();
  }, 500);
});

async function updatePreview() {
  if (!currentNote) return;
  let md = currentNote.content;

  // Resolve describe://img/<id> to base64
  const imgRegex = /describe:\/\/img\/([a-z0-9]+)/g;
  const matches = [...md.matchAll(imgRegex)];
  for (const m of matches) {
    const img = await dbGet('images', m[1]);
    if (img) md = md.replace(m[0], img.data);
  }

  // Insert branch-point markers into the markdown before parsing
  // For the original note: show where each BA forked off
  const branchMarkers = [];
  const childBranches = allNotes
    .filter(n => n.branchFrom === currentNote.id && n.branchAt != null)
    .sort((a, b) => b.branchAt - a.branchAt); // insert from end to preserve positions

  for (const child of childBranches) {
    // Account for the header line we prepend to BA notes
    const headerLine = '# ' + child.title + '\n\n';
    const adjustedPos = Math.min(child.branchAt, md.length);
    branchMarkers.push({ pos: adjustedPos, label: child.title });
  }

  // For a BA note itself: mark the end where branching happened
  if (currentNote.branchFrom) {
    const parent = allNotes.find(n => n.id === currentNote.branchFrom);
    if (parent) {
      branchMarkers.push({ pos: md.length, label: 'Branched from: ' + parent.title });
    }
  }

  // Insert markers (from end to start so positions stay valid)
  branchMarkers.sort((a, b) => b.pos - a.pos);
  for (const marker of branchMarkers) {
    const tag = `\n<!-- BRANCH_MARKER:${marker.label} -->\n`;
    md = md.slice(0, marker.pos) + tag + md.slice(marker.pos);
  }

  let html = marked.parse(md);

  // Replace branch marker comments with visible HTML
  html = html.replace(/<!-- BRANCH_MARKER:(.*?) -->/g, (match, label) => {
    const escaped = label.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return `<div class="branch-marker"><span class="branch-marker-icon">&#9582;</span> ${escaped}</div>`;
  });

  // Resolve [[wiki links]] to clickable links (after markdown parsing)
  html = html.replace(/\[\[([^\]]+)\]\]/g, (match, title) => {
    const linked = allNotes.find(n => n.title.toLowerCase() === title.toLowerCase());
    if (linked) {
      return `<a href="#" class="wiki-link" data-note-id="${linked.id}">${title}</a>`;
    }
    return `<span class="wiki-link broken">${title}</span>`;
  });

  $preview.innerHTML = html;

  // Apply highlight.js to code blocks
  $preview.querySelectorAll('pre code').forEach(block => {
    hljs.highlightElement(block);
  });

  // Budget chart rendering
  if (currentNote && currentNote.content.trimStart().startsWith('<!-- budget -->')) {
    renderBudgetCharts($preview);
  }
}

function parseBudgetTables(container) {
  const sections = { income: [], fixedExpenses: [], variableExpenses: [], savings: [] };
  const headings = container.querySelectorAll('h2');
  headings.forEach(h2 => {
    const text = h2.textContent.trim().toLowerCase();
    const table = h2.nextElementSibling;
    if (!table || table.tagName !== 'TABLE') return;
    const rows = table.querySelectorAll('tbody tr');
    let key = null;
    if (text === 'income') key = 'income';
    else if (text === 'fixed expenses') key = 'fixedExpenses';
    else if (text === 'variable expenses') key = 'variableExpenses';
    else if (text.includes('savings')) key = 'savings';
    if (!key) return;
    rows.forEach(row => {
      const cells = row.querySelectorAll('td');
      if (cells.length >= 2) {
        const label = cells[0].textContent.trim();
        const amount = parseFloat(cells[1].textContent.replace(/[^0-9.\-]/g, '')) || 0;
        if (label) sections[key].push({ label, amount });
      }
    });
  });
  return sections;
}

function renderBudgetCharts(container) {
  const data = parseBudgetTables(container);
  const totalIncome = data.income.reduce((s, r) => s + r.amount, 0);
  const totalFixed = data.fixedExpenses.reduce((s, r) => s + r.amount, 0);
  const totalVariable = data.variableExpenses.reduce((s, r) => s + r.amount, 0);
  const totalSavings = data.savings.reduce((s, r) => s + r.amount, 0);
  const totalExpenses = totalFixed + totalVariable;
  const netMonthly = totalIncome - totalExpenses - totalSavings;

  // Find or create the chart container after the Projections heading
  let anchor = null;
  container.querySelectorAll('h2').forEach(h => {
    if (h.textContent.trim().toLowerCase() === 'projections') anchor = h;
  });
  if (!anchor) return;

  // Remove the blockquote hint after projections heading
  const hint = anchor.nextElementSibling;
  if (hint && hint.tagName === 'BLOCKQUOTE') hint.remove();

  const wrapper = document.createElement('div');
  wrapper.className = 'budget-dashboard';

  // Time period selector
  const periods = [
    { label: '1 Month', months: 1 },
    { label: '3 Months', months: 3 },
    { label: '6 Months', months: 6 },
    { label: '12 Months', months: 12 }
  ];

  const toolbar = document.createElement('div');
  toolbar.className = 'budget-toolbar';
  let activeMonths = 1;

  periods.forEach((p, i) => {
    const btn = document.createElement('button');
    btn.className = 'budget-period-btn' + (i === 0 ? ' active' : '');
    btn.textContent = p.label;
    btn.addEventListener('click', () => {
      toolbar.querySelectorAll('.budget-period-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      activeMonths = p.months;
      updateDashboard();
    });
    toolbar.appendChild(btn);
  });
  wrapper.appendChild(toolbar);

  // Summary cards
  const summaryRow = document.createElement('div');
  summaryRow.className = 'budget-summary';
  wrapper.appendChild(summaryRow);

  // Chart area — two canvases side by side
  const chartRow = document.createElement('div');
  chartRow.className = 'budget-chart-row';

  const barSection = document.createElement('div');
  barSection.className = 'budget-chart-section';
  const barTitle = document.createElement('div');
  barTitle.className = 'budget-chart-title';
  barTitle.textContent = 'Income vs Expenses';
  const barCanvas = document.createElement('canvas');
  barCanvas.width = 400; barCanvas.height = 260;
  barSection.append(barTitle, barCanvas);

  const pieSection = document.createElement('div');
  pieSection.className = 'budget-chart-section';
  const pieTitle = document.createElement('div');
  pieTitle.className = 'budget-chart-title';
  pieTitle.textContent = 'Expense Breakdown';
  const pieCanvas = document.createElement('canvas');
  pieCanvas.width = 300; pieCanvas.height = 260;
  pieSection.append(pieTitle, pieCanvas);

  chartRow.append(barSection, pieSection);
  wrapper.appendChild(chartRow);

  // Projection table
  const projDiv = document.createElement('div');
  projDiv.className = 'budget-projection-table';
  wrapper.appendChild(projDiv);

  anchor.after(wrapper);

  const fmt = n => {
    const sign = n < 0 ? '-' : '';
    return sign + '$' + Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  };

  function updateDashboard() {
    const m = activeMonths;
    const inc = totalIncome * m;
    const exp = totalExpenses * m;
    const sav = totalSavings * m;
    const net = netMonthly * m;

    // Summary cards
    summaryRow.innerHTML = '';
    const cards = [
      { label: 'Total Income', value: inc, cls: 'income' },
      { label: 'Total Expenses', value: exp, cls: 'expense' },
      { label: 'Total Savings', value: sav, cls: 'savings' },
      { label: 'Net Balance', value: net, cls: net >= 0 ? 'income' : 'expense' }
    ];
    cards.forEach(c => {
      const card = document.createElement('div');
      card.className = 'budget-card budget-card-' + c.cls;
      card.innerHTML = `<div class="budget-card-label">${c.label}</div><div class="budget-card-value">${fmt(c.value)}</div><div class="budget-card-sub">${m > 1 ? fmt(c.value / m) + '/mo' : ''}</div>`;
      summaryRow.appendChild(card);
    });

    // Bar chart
    drawBarChart(barCanvas, data, m);

    // Pie chart
    drawPieChart(pieCanvas, data, m);

    // Projection table
    projDiv.innerHTML = '';
    const table = document.createElement('table');
    table.className = 'budget-proj-tbl';
    let thtml = '<thead><tr><th>Month</th><th>Income</th><th>Expenses</th><th>Savings</th><th>Net</th><th>Cumulative</th></tr></thead><tbody>';
    let cumulative = 0;
    for (let i = 1; i <= m; i++) {
      cumulative += netMonthly;
      thtml += `<tr><td>${i}</td><td>${fmt(totalIncome)}</td><td>${fmt(totalExpenses)}</td><td>${fmt(totalSavings)}</td><td class="${netMonthly >= 0 ? 'proj-pos' : 'proj-neg'}">${fmt(netMonthly)}</td><td class="${cumulative >= 0 ? 'proj-pos' : 'proj-neg'}">${fmt(cumulative)}</td></tr>`;
    }
    thtml += '</tbody>';
    table.innerHTML = thtml;
    projDiv.appendChild(table);
  }

  updateDashboard();
}

function drawBarChart(canvas, data, months) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = w * dpr; canvas.height = h * dpr;
  canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);

  const categories = [
    { label: 'Income', value: data.income.reduce((s, r) => s + r.amount, 0) * months, color: '#a6e3a1' },
    { label: 'Fixed', value: data.fixedExpenses.reduce((s, r) => s + r.amount, 0) * months, color: '#f38ba8' },
    { label: 'Variable', value: data.variableExpenses.reduce((s, r) => s + r.amount, 0) * months, color: '#fab387' },
    { label: 'Savings', value: data.savings.reduce((s, r) => s + r.amount, 0) * months, color: '#89b4fa' }
  ];

  const maxVal = Math.max(...categories.map(c => c.value), 1);
  const pad = { top: 10, bottom: 30, left: 10, right: 10 };
  const chartW = w - pad.left - pad.right;
  const chartH = h - pad.top - pad.bottom;
  const barW = chartW / categories.length * 0.6;
  const gap = chartW / categories.length;

  const textColor = getComputedStyle(document.documentElement).getPropertyValue('--text-secondary').trim();
  ctx.fillStyle = textColor;
  ctx.font = '11px -apple-system, sans-serif';
  ctx.textAlign = 'center';

  categories.forEach((cat, i) => {
    const x = pad.left + gap * i + (gap - barW) / 2;
    const barH = (cat.value / maxVal) * chartH;
    const y = pad.top + chartH - barH;

    ctx.fillStyle = cat.color;
    ctx.beginPath();
    const r = 4;
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + barW - r, y);
    ctx.quadraticCurveTo(x + barW, y, x + barW, y + r);
    ctx.lineTo(x + barW, y + barH);
    ctx.lineTo(x, y + barH);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.fill();

    ctx.fillStyle = textColor;
    ctx.fillText(cat.label, x + barW / 2, h - 8);

    if (cat.value > 0) {
      ctx.fillStyle = textColor;
      ctx.fillText('$' + cat.value.toLocaleString(), x + barW / 2, y - 4);
    }
  });
}

function drawPieChart(canvas, data, months) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = w * dpr; canvas.height = h * dpr;
  canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);

  const allExpenses = [...data.fixedExpenses, ...data.variableExpenses]
    .filter(r => r.amount > 0)
    .map(r => ({ label: r.label, value: r.amount * months }));

  if (allExpenses.length === 0) {
    const textColor = getComputedStyle(document.documentElement).getPropertyValue('--text-muted').trim();
    ctx.fillStyle = textColor;
    ctx.font = '13px -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('No expense data', w / 2, h / 2);
    return;
  }

  const total = allExpenses.reduce((s, r) => s + r.value, 0);
  const colors = ['#f38ba8', '#fab387', '#f9e2af', '#a6e3a1', '#89b4fa', '#cba6f7', '#f5c2e7', '#94e2d5', '#74c7ec', '#b4befe', '#f2cdcd', '#89dceb', '#eba0ac', '#a6adc8'];
  const cx = w / 2, cy = h / 2 - 10, radius = Math.min(w, h) / 2 - 30;
  let startAngle = -Math.PI / 2;

  const textColor = getComputedStyle(document.documentElement).getPropertyValue('--text-secondary').trim();

  allExpenses.forEach((item, i) => {
    const slice = (item.value / total) * Math.PI * 2;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, radius, startAngle, startAngle + slice);
    ctx.closePath();
    ctx.fillStyle = colors[i % colors.length];
    ctx.fill();
    ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--bg-primary').trim();
    ctx.lineWidth = 2;
    ctx.stroke();

    // Label
    if (slice > 0.15) {
      const mid = startAngle + slice / 2;
      const lx = cx + Math.cos(mid) * (radius * 0.65);
      const ly = cy + Math.sin(mid) * (radius * 0.65);
      ctx.fillStyle = '#1e1e2e';
      ctx.font = 'bold 10px -apple-system, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(item.label, lx, ly - 6);
      ctx.font = '9px -apple-system, sans-serif';
      ctx.fillText(Math.round(item.value / total * 100) + '%', lx, ly + 6);
    }

    startAngle += slice;
  });

  // Legend below
  ctx.font = '10px -apple-system, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  const legendY = cy + radius + 12;
  const cols = Math.min(allExpenses.length, 4);
  const colW = w / cols;
  allExpenses.forEach((item, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const lx = col * colW + 4;
    const ly = legendY + row * 14;
    ctx.fillStyle = colors[i % colors.length];
    ctx.fillRect(lx, ly, 8, 8);
    ctx.fillStyle = textColor;
    ctx.fillText(item.label, lx + 12, ly - 1);
  });
}

// Navigate to linked note when wiki link is clicked
$preview.addEventListener('click', e => {
  const link = e.target.closest('.wiki-link');
  if (!link) return;
  e.preventDefault();
  const noteId = link.dataset.noteId;
  if (noteId) {
    openNote(noteId);
  }
});

function updateWordCount() {
  const text = (currentNote ? currentNote.content : $editor.value).trim();
  const words = text ? text.split(/\s+/).length : 0;

  if (currentNote && currentNote.wordGoal) {
    const goal = currentNote.wordGoal;
    $wordCount.textContent = `${words} / ${goal} words`;
    const pct = Math.min(100, (words / goal) * 100);
    $wordGoalBar.style.width = pct + '%';

    if (words >= goal) {
      if (!$wordCountWrapper.classList.contains('goal-complete')) {
        $wordCountWrapper.classList.add('goal-complete');
      }
    } else {
      $wordCountWrapper.classList.remove('goal-complete');
    }
  } else {
    $wordCount.textContent = `${words} word${words !== 1 ? 's' : ''}`;
    $wordGoalBar.style.width = '0%';
    $wordCountWrapper.classList.remove('goal-complete');
  }
}

// ===== Toolbar =====
document.getElementById('toolbar').addEventListener('click', e => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const action = btn.dataset.action;
  applyFormat(action);
});

function applyFormat(action) {
  if (!currentNote) return;

  // Rich mode: use execCommand
  if (richMode) {
    switch (action) {
      case 'bold': document.execCommand('bold'); break;
      case 'italic': document.execCommand('italic'); break;
      case 'h1': document.execCommand('formatBlock', false, 'h1'); break;
      case 'h2': document.execCommand('formatBlock', false, 'h2'); break;
      case 'h3': document.execCommand('formatBlock', false, 'h3'); break;
      case 'code': document.execCommand('insertHTML', false, '<code>code</code>'); break;
      case 'ul': document.execCommand('insertUnorderedList'); break;
      case 'ol': document.execCommand('insertOrderedList'); break;
      case 'blockquote': document.execCommand('formatBlock', false, 'blockquote'); break;
      case 'hr': document.execCommand('insertHorizontalRule'); break;
      case 'link':
        const url = prompt('URL:');
        if (url) document.execCommand('createLink', false, url);
        break;
      case 'image': triggerImageInsert(); break;
    }
    clearTimeout(richSyncTimeout);
    richSyncTimeout = setTimeout(() => syncRichToMarkdown(), 500);
    return;
  }

  const start = $editor.selectionStart;
  const end = $editor.selectionEnd;
  const sel = $editor.value.substring(start, end);
  let before = '', after = '', insert = '';

  switch (action) {
    case 'bold': before = '**'; after = '**'; break;
    case 'italic': before = '_'; after = '_'; break;
    case 'h1': before = '# '; break;
    case 'h2': before = '## '; break;
    case 'h3': before = '### '; break;
    case 'code': before = '`'; after = '`'; break;
    case 'codeblock': before = '```\n'; after = '\n```'; break;
    case 'link': before = '['; after = '](url)'; break;
    case 'image': triggerImageInsert(); return;
    case 'ul': before = '- '; break;
    case 'ol': before = '1. '; break;
    case 'blockquote': before = '> '; break;
    case 'hr': insert = '\n---\n'; break;
    default: return;
  }

  if (insert) {
    $editor.setRangeText(insert, start, end, 'end');
  } else {
    const replacement = before + (sel || 'text') + (after || '');
    $editor.setRangeText(replacement, start, end, 'end');
    if (!sel) {
      $editor.selectionStart = start + before.length;
      $editor.selectionEnd = start + before.length + 4; // select "text"
    }
  }

  $editor.focus();
  $editor.dispatchEvent(new Event('input'));
}

// ===== Screeeeh =====
const screeeehWords = [
  "zr'kthaa", "vøxilm", "ðhaa'qi", "blrrrx", "skrïïnt", "ch'vaal",
  "nyx'thar", "grøøvl", "plt'xik", "zzhaam", "kr'vëën", "qua'zith",
  "mhörx", "t'sklrr", "xëën'dra", "vr'pthak", "ülm'gaa", "zh'rraak",
  "fthøøn", "sk'liirm", "drëëx'ul", "bv'naath", "yrr'kzha", "phl'gørm",
  "xh'taalk", "rrüüz'vak", "gl'ööthm", "nzr'aaxi", "kv'shtaal", "thr'zzik",
  "w'xhöörn", "qzr'ëëlm", "jh'viikt", "ül'thrax", "skh'rööm", "pzr'naag",
  "v'thliik", "ørr'gzha", "mzl'küün", "dh'rraxt", "çk'vaalm", "zhr'piith",
  "xt'grööl", "bh'zaakt", "fl'ürrnx", "kr'shøøl", "nth'vëëx", "gh'zliim",
  "wr'pthöö", "sk'draalx"
];

const screeeehPhrases = [
  "zr'kthaa vøxilm ðhaa'qi — blrrrx skrïïnt ch'vaal!",
  "nyx'thar grøøvl plt'xik zzhaam kr'vëën.",
  "qua'zith mhörx t'sklrr: xëën'dra vr'pthak ülm'gaa.",
  "zh'rraak fthøøn sk'liirm drëëx'ul bv'naath yrr'kzha...",
  "phl'gørm xh'taalk, rrüüz'vak gl'ööthm nzr'aaxi!",
  "kv'shtaal thr'zzik w'xhöörn qzr'ëëlm — jh'viikt ül'thrax.",
  "skh'rööm pzr'naag v'thliik; ørr'gzha mzl'küün dh'rraxt.",
  "çk'vaalm zhr'piith xt'grööl bh'zaakt fl'ürrnx?",
  "kr'shøøl nth'vëëx gh'zliim wr'pthöö sk'draalx.",
  "plt'xik zh'rraak — çk'vaalm nyx'thar grøøvl ülm'gaa!",
  "v'thliik xëën'dra sk'liirm... bv'naath yrr'kzha phl'gørm.",
  "qzr'ëëlm dh'rraxt rrüüz'vak, gl'ööthm thr'zzik mhörx?"
];

function generateScreeeeh() {
  const paraCount = 2 + Math.floor(Math.random() * 3);
  const paragraphs = [];
  for (let p = 0; p < paraCount; p++) {
    const sentCount = 2 + Math.floor(Math.random() * 4);
    const sentences = [];
    for (let s = 0; s < sentCount; s++) {
      sentences.push(screeeehPhrases[Math.floor(Math.random() * screeeehPhrases.length)]);
    }
    paragraphs.push(sentences.join(' '));
  }
  return '\n\n' + paragraphs.join('\n\n') + '\n\n';
}

document.getElementById('screeeeh-btn').addEventListener('click', () => {
  if (!currentNote) return;
  const text = generateScreeeeh();
  const pos = $editor.selectionStart;
  $editor.setRangeText(text, pos, pos, 'end');
  $editor.focus();
  $editor.dispatchEvent(new Event('input'));
});

// ===== Break Away =====
document.getElementById('breakaway-btn').addEventListener('click', async () => {
  if (!currentNote) return;

  // Save current note first
  await dbPut('notes', currentNote);

  // Content up to the cursor becomes the new branch note
  const cursorPos = $editor.selectionStart;
  const branchContent = currentNote.content.slice(0, cursorPos);

  // Use the original note's base name (strip any existing BA version suffix)
  const baseName = currentNote.title.replace(/\s*\[BA v\d+\]$/, '');

  // Count existing BA versions to label properly
  const versionPattern = new RegExp(
    '^' + baseName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\[BA v(\\d+)\\]$'
  );
  let maxV = 0;
  for (const n of allNotes) {
    const m = n.title.match(versionPattern);
    if (m) maxV = Math.max(maxV, parseInt(m[1]));
  }
  const finalTitle = baseName.slice(0, 49) + ' [BA v' + (maxV + 1) + ']';

  // Prepend the title as a heading at the top of the branch content
  const headerLine = '# ' + finalTitle + '\n\n';
  const branchContent_with_header = headerLine + branchContent;

  const branchNote = {
    id: uid(),
    folderId: currentNote.folderId,
    title: finalTitle,
    content: branchContent_with_header,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    sortOrder: allNotes.length,
    branchFrom: currentNote.id,
    branchAt: cursorPos
  };

  await dbPut('notes', branchNote);
  allNotes.push(branchNote);
  renderTree();
  openNote(branchNote.id);

  $statusMsg.textContent = 'Branched — keep writing!';
});

// ===== Branch Visualization =====
const $branchPanel = document.getElementById('branch-panel');

function getBranchFamily(noteId) {
  // Walk up to find the root (original) note
  let root = allNotes.find(n => n.id === noteId);
  if (!root) return null;
  while (root.branchFrom) {
    const parent = allNotes.find(n => n.id === root.branchFrom);
    if (!parent) break;
    root = parent;
  }
  // Collect all branches that descend from this root
  const family = { root, branches: [] };
  function collectBranches(parentId) {
    const children = allNotes
      .filter(n => n.branchFrom === parentId)
      .sort((a, b) => (a.branchAt || 0) - (b.branchAt || 0));
    for (const child of children) {
      family.branches.push(child);
      collectBranches(child.id);
    }
  }
  collectBranches(root.id);
  return family;
}

function renderBranchPanel() {
  if (!currentNote) {
    $branchPanel.classList.add('hidden');
    return;
  }

  const family = getBranchFamily(currentNote.id);
  if (!family || family.branches.length === 0) {
    $branchPanel.classList.add('hidden');
    return;
  }

  $branchPanel.classList.remove('hidden');

  const root = family.root;
  const rootLen = root.content.length || 1;

  const canvas = document.getElementById('branch-canvas');
  canvas.innerHTML = '';

  // Wait a frame so canvas has layout width
  requestAnimationFrame(() => {
    const width = canvas.clientWidth || 400;
    const nodeR = 6;
    const rowHeight = 30;
    const pad = 16;
    const labelMaxW = Math.min(160, width * 0.3);

    // Layout all branch nodes
    const nodes = [];
    let branchRow = 1;

    function layoutBranches(parentId, parentLen) {
      const branches = allNotes
        .filter(n => n.branchFrom === parentId)
        .sort((a, b) => (a.branchAt || 0) - (b.branchAt || 0));
      for (const b of branches) {
        const pos = Math.min(b.branchAt || 0, parentLen);
        const xFrac = pos / (parentLen || 1);
        nodes.push({ note: b, xFrac, row: branchRow, parentId });
        branchRow++;
        layoutBranches(b.id, b.content.length);
      }
    }

    layoutBranches(root.id, rootLen);

    const trunkLeft = pad;
    const trunkRight = width - pad - labelMaxW;
    const trunkLen = Math.max(trunkRight - trunkLeft, 60);
    const trunkLineY = rowHeight;
    const totalHeight = (branchRow + 1) * rowHeight;
    const branchOffsetX = 24; // how far right the branch node sits from fork point

    let svg = `<svg width="${width}" height="${totalHeight}" xmlns="http://www.w3.org/2000/svg" style="display:block">`;

    // Trunk line
    svg += `<line x1="${trunkLeft}" y1="${trunkLineY}" x2="${trunkLeft + trunkLen}" y2="${trunkLineY}" stroke="var(--accent)" stroke-width="2.5" stroke-linecap="round"/>`;

    // Root dot
    const isRootActive = currentNote.id === root.id;
    const rootDeleted = root.deleted;
    const rootDotFill = rootDeleted ? 'var(--danger)' : (isRootActive ? 'var(--accent)' : 'var(--bg-tertiary)');
    const rootStroke = rootDeleted ? 'var(--danger)' : 'var(--accent)';
    svg += `<circle cx="${trunkLeft}" cy="${trunkLineY}" r="${nodeR}" fill="${rootDotFill}" stroke="${rootStroke}" stroke-width="2" class="branch-node" ${rootDeleted ? '' : `data-note-id="${root.id}"`}/>`;

    // Root label — right of trunk end
    const rootLabel = truncLabel(root.title, 28);
    const rootLabelFill = rootDeleted ? 'var(--danger)' : (isRootActive ? 'var(--accent)' : 'var(--text-secondary)');
    svg += `<text x="${trunkLeft + trunkLen + 10}" y="${trunkLineY + 4}" fill="${rootLabelFill}" font-size="11" font-weight="600" class="branch-label" ${rootDeleted ? 'text-decoration="line-through" opacity="0.6"' : `data-note-id="${root.id}"`}>${escSvg(rootLabel)}${rootDeleted ? ' (deleted)' : ''}</text>`;
    if (rootDeleted) {
      // Strikethrough line
      const textW = rootLabel.length * 6;
      svg += `<line x1="${trunkLeft + trunkLen + 10}" y1="${trunkLineY + 1}" x2="${trunkLeft + trunkLen + 10 + textW}" y2="${trunkLineY + 1}" stroke="var(--danger)" stroke-width="1" opacity="0.6"/>`;
    }

    // Trunk line color if root deleted
    if (rootDeleted) {
      svg += `<line x1="${trunkLeft}" y1="${trunkLineY}" x2="${trunkLeft + trunkLen}" y2="${trunkLineY}" stroke="var(--danger)" stroke-width="2.5" stroke-linecap="round" opacity="0.3"/>`;
    }

    // Branches
    for (const node of nodes) {
      const forkX = trunkLeft + node.xFrac * trunkLen;
      const branchY = (node.row + 1) * rowHeight;
      const isActive = currentNote.id === node.note.id;
      const isDeleted = node.note.deleted;

      // Parent Y position
      let parentY = trunkLineY;
      let parentForkX = forkX;
      if (node.parentId !== root.id) {
        const parentNode = nodes.find(n => n.note.id === node.parentId);
        if (parentNode) {
          parentY = (parentNode.row + 1) * rowHeight;
          const parentParent = allNotes.find(n => n.id === parentNode.parentId);
          const ppLen = parentParent ? parentParent.content.length || 1 : rootLen;
          parentForkX = trunkLeft + (Math.min(node.note.branchAt || 0, ppLen) / ppLen) * trunkLen;
        }
      }

      const nodeX = forkX + branchOffsetX;
      const lineOpacity = isDeleted ? '0.2' : '0.4';

      // Vertical line down from fork point
      svg += `<line x1="${forkX}" y1="${parentY}" x2="${forkX}" y2="${branchY}" stroke="${isDeleted ? 'var(--danger)' : 'var(--text-muted)'}" stroke-width="1.5" opacity="${lineOpacity}"/>`;
      // Horizontal tick to node
      svg += `<line x1="${forkX}" y1="${branchY}" x2="${nodeX}" y2="${branchY}" stroke="${isDeleted ? 'var(--danger)' : 'var(--text-muted)'}" stroke-width="1.5" opacity="${lineOpacity}"/>`;

      // Fork dot on parent line
      svg += `<circle cx="${forkX}" cy="${parentY}" r="3.5" fill="${isDeleted ? 'var(--danger)' : 'var(--warning)'}" stroke="var(--bg-secondary)" stroke-width="1.5" opacity="${isDeleted ? '0.5' : '1'}"/>`;

      // Branch node
      const nodeFill = isDeleted ? 'var(--danger)' : (isActive ? 'var(--accent)' : 'var(--bg-tertiary)');
      const nodeStroke = isDeleted ? 'var(--danger)' : (isActive ? 'var(--accent)' : 'var(--text-muted)');
      const nodeOpacity = isDeleted ? '0.5' : '1';
      svg += `<circle cx="${nodeX}" cy="${branchY}" r="${nodeR}" fill="${nodeFill}" stroke="${nodeStroke}" stroke-width="2" opacity="${nodeOpacity}" class="branch-node" ${isDeleted ? '' : `data-note-id="${node.note.id}"`}/>`;

      // Label
      const label = truncLabel(node.note.title, 28);
      const labelFill = isDeleted ? 'var(--danger)' : (isActive ? 'var(--accent)' : 'var(--text-secondary)');
      const labelOpacity = isDeleted ? '0.6' : '1';
      svg += `<text x="${nodeX + 12}" y="${branchY + 4}" fill="${labelFill}" font-size="11" font-weight="${isActive ? '600' : '400'}" opacity="${labelOpacity}" class="branch-label" ${isDeleted ? '' : `data-note-id="${node.note.id}"`}>${escSvg(label)}${isDeleted ? ' (deleted)' : ''}</text>`;

      // Strikethrough for deleted
      if (isDeleted) {
        const textW = (label.length + 10) * 5.5;
        svg += `<line x1="${nodeX + 12}" y1="${branchY + 1}" x2="${nodeX + 12 + textW}" y2="${branchY + 1}" stroke="var(--danger)" stroke-width="1" opacity="0.5"/>`;
      }
    }

    svg += '</svg>';
    canvas.innerHTML = svg;

    // Click handlers — only on non-deleted nodes
    canvas.querySelectorAll('[data-note-id]').forEach(el => {
      el.style.cursor = 'pointer';
      el.addEventListener('click', () => openNote(el.dataset.noteId));
    });
  });
}

function truncLabel(str, max) {
  return str.length > max ? str.slice(0, max - 1) + '…' : str;
}

function escSvg(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ===== Editor Branch Highlight Overlay =====
const $editorHighlight = document.getElementById('editor-highlight');

function updateEditorHighlight() {
  const text = $editor.value;
  const lines = text.split('\n');
  let html = '';
  for (const line of lines) {
    const escaped = line.replace(/&/g, '&amp;').replace(/</g, '&lt;');
    if (line.startsWith('── ⑂ ')) {
      html += '<span class="branch-line">' + escaped + '</span>\n';
    } else {
      html += escaped + '\n';
    }
  }
  $editorHighlight.innerHTML = html;
  $editorHighlight.scrollTop = $editor.scrollTop;
}

$editor.addEventListener('scroll', () => {
  $editorHighlight.scrollTop = $editor.scrollTop;
});

// ===== Minimap =====
const $minimap = document.getElementById('minimap');
const $minimapContent = document.getElementById('minimap-content');
const $minimapViewport = document.getElementById('minimap-viewport');
let minimapHideTimer = null;

function updateMinimapContent() {
  if (!currentNote) return;
  // Render a tiny version of the text
  const text = stripBranchMarkers($editor.value);
  // Truncate to keep minimap performant
  $minimapContent.textContent = text.slice(0, 5000);
}

function updateMinimapViewport() {
  const scrollHeight = $editor.scrollHeight;
  const clientHeight = $editor.clientHeight;
  const scrollTop = $editor.scrollTop;

  if (scrollHeight <= clientHeight) {
    $minimap.classList.remove('visible');
    return;
  }

  const mapVisibleHeight = $minimap.clientHeight;
  const mapFullHeight = $minimapContent.scrollHeight;
  const viewFrac = clientHeight / scrollHeight;
  const topFrac = scrollTop / (scrollHeight - clientHeight);

  // Scroll the minimap content to follow the editor
  if (mapFullHeight > mapVisibleHeight) {
    $minimapContent.scrollTop = topFrac * (mapFullHeight - mapVisibleHeight);
  }

  // Position viewport indicator within the visible minimap area
  const vpHeight = Math.max(8, viewFrac * mapVisibleHeight);
  const vpTop = topFrac * (mapVisibleHeight - vpHeight);

  $minimapViewport.style.height = vpHeight + 'px';
  $minimapViewport.style.top = vpTop + 'px';
}

$editor.addEventListener('scroll', () => {
  const scrollHeight = $editor.scrollHeight;
  const clientHeight = $editor.clientHeight;

  // Only show minimap if content is scrollable
  if (scrollHeight <= clientHeight) return;

  $minimap.classList.add('visible');
  updateMinimapViewport();

  clearTimeout(minimapHideTimer);
  minimapHideTimer = setTimeout(() => {
    $minimap.classList.remove('visible');
  }, 1500);
});

// Update minimap content when note changes
const origEditorInput = $editor.oninput;
$editor.addEventListener('input', () => {
  updateMinimapContent();
  updateMinimapViewport();
});

// Branch panel collapse toggle
document.getElementById('branch-panel-toggle').addEventListener('click', () => {
  $branchPanel.classList.toggle('collapsed');
});

// ===== Keyboard Shortcuts =====
document.addEventListener('keydown', e => {
  // Ctrl+B Bold
  if (e.ctrlKey && e.key === 'b') {
    e.preventDefault();
    applyFormat('bold');
  }
  // Ctrl+I Italic
  if (e.ctrlKey && e.key === 'i') {
    e.preventDefault();
    applyFormat('italic');
  }
  // Ctrl+K Link
  if (e.ctrlKey && e.key === 'k') {
    e.preventDefault();
    applyFormat('link');
  }
  // Ctrl+Shift+F Search
  if (e.ctrlKey && e.shiftKey && e.key === 'F') {
    e.preventDefault();
    $searchInput.focus();
    $searchInput.select();
  }
  // Ctrl+Z Undo / Ctrl+Shift+Z Redo (note content, last 3 changes)
  if (e.ctrlKey && e.key === 'z' && !e.shiftKey) {
    if (currentNote) {
      const prev = undoApply(currentNote.id, -1);
      if (prev !== null) {
        e.preventDefault();
        currentNote.content = prev;
        currentNote.updatedAt = Date.now();
        $editor.value = prev;
        updatePreview();
        updateWordCount();
        updateEditorHighlight();
        updateMinimapContent();
        setSaveStatus('saving');
        dbPut('notes', currentNote).then(() => setSaveStatus('saved'));
        renderTree();
      }
    }
  }
  if (e.ctrlKey && e.shiftKey && e.key === 'Z') {
    if (currentNote) {
      const next = undoApply(currentNote.id, 1);
      if (next !== null) {
        e.preventDefault();
        currentNote.content = next;
        currentNote.updatedAt = Date.now();
        $editor.value = next;
        updatePreview();
        updateWordCount();
        updateEditorHighlight();
        updateMinimapContent();
        setSaveStatus('saving');
        dbPut('notes', currentNote).then(() => setSaveStatus('saved'));
        renderTree();
      }
    }
  }
  // Escape close modals/dropdowns
  if (e.key === 'Escape') {
    closeSearchDropdown();
    $exportModal.classList.add('hidden');
    hideContextMenu();
  }
});

// Tab key in editor
$editor.addEventListener('keydown', e => {
  if (e.key === 'Tab') {
    e.preventDefault();
    const start = $editor.selectionStart;
    $editor.setRangeText('  ', start, start, 'end');
    $editor.dispatchEvent(new Event('input'));
  }
});

// ===== View Modes =====
document.getElementById('view-edit').addEventListener('click', () => setViewMode('view-edit'));
document.getElementById('view-split').addEventListener('click', () => setViewMode('view-split'));
document.getElementById('view-preview').addEventListener('click', () => setViewMode('view-preview'));

function setViewMode(mode) {
  // Leaving rich mode: sync back
  if (richMode && mode !== 'view-rich') {
    syncRichToMarkdown();
    richMode = false;
    $preview.contentEditable = 'false';
    $preview.classList.remove('rich-editable');
  }

  $editorContainer.className = mode;
  document.querySelectorAll('.view-btn').forEach(b => b.classList.remove('active'));
  document.getElementById(mode)?.classList.add('active');

  // Entering rich mode
  if (mode === 'view-rich') {
    richMode = true;
    $preview.contentEditable = 'true';
    $preview.classList.add('rich-editable');
    updatePreview();
    // Listen for rich mode input
    $preview.oninput = () => {
      clearTimeout(richSyncTimeout);
      richSyncTimeout = setTimeout(() => {
        syncRichToMarkdown();
      }, 500);
    };
    // Strip HTML on paste in rich mode
    $preview.onpaste = e => {
      e.preventDefault();
      // Allow image paste
      const items = e.clipboardData?.items;
      if (items) {
        for (const item of items) {
          if (item.type.startsWith('image/')) {
            insertImage(item.getAsFile());
            return;
          }
        }
      }
      const text = e.clipboardData.getData('text/plain');
      document.execCommand('insertText', false, text);
    };
  } else {
    $preview.contentEditable = 'false';
    $preview.classList.remove('rich-editable');
    $preview.oninput = null;
    $preview.onpaste = null;
  }

  dbPut('settings', { key: 'viewMode', value: mode });
}

function syncRichToMarkdown() {
  if (!richMode || !currentNote) return;
  const td = getTurndown();
  if (!td) return;
  const md = td.turndown($preview.innerHTML);
  currentNote.content = md;
  currentNote.updatedAt = Date.now();
  $editor.value = md;
  setSaveStatus('typing');
  clearTimeout(saveTimeout);
  saveTimeout = setTimeout(async () => {
    setSaveStatus('saving');
    await dbPut('notes', currentNote);
    undoPushState(currentNote.id, currentNote.content);
    setSaveStatus('saved');
    updateWordCount();
  }, 500);
}

// ===== Images =====
function triggerImageInsert() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.onchange = () => {
    if (input.files[0]) insertImage(input.files[0]);
  };
  input.click();
}

async function insertImage(file) {
  if (!currentNote) return;
  const reader = new FileReader();
  reader.onload = async () => {
    const imgRecord = {
      id: uid(),
      noteId: currentNote.id,
      data: reader.result,
      name: file.name,
      createdAt: Date.now()
    };
    await dbPut('images', imgRecord);
    const mdImg = `![${file.name}](describe://img/${imgRecord.id})`;
    const pos = $editor.selectionStart;
    $editor.setRangeText(mdImg, pos, pos, 'end');
    $editor.dispatchEvent(new Event('input'));
  };
  reader.readAsDataURL(file);
}

// Paste image
$editor.addEventListener('paste', e => {
  const items = e.clipboardData?.items;
  if (!items) return;
  for (const item of items) {
    if (item.type.startsWith('image/')) {
      e.preventDefault();
      insertImage(item.getAsFile());
      return;
    }
  }
});

// Drag-drop image onto editor
$editor.addEventListener('dragover', e => {
  if (e.dataTransfer.types.includes('Files')) e.preventDefault();
});

$editor.addEventListener('drop', e => {
  const files = e.dataTransfer?.files;
  if (!files) return;
  for (const file of files) {
    if (file.type.startsWith('image/')) {
      e.preventDefault();
      insertImage(file);
      return;
    }
  }
});

// ===== Search (inline header dropdown) =====
let searchSelectedIdx = -1;

function closeSearchDropdown() {
  $searchDropdown.classList.add('hidden');
  $searchDropdown.innerHTML = '';
  searchSelectedIdx = -1;
  document.getElementById('header-search').classList.remove('mobile-search-open');
}

$searchInput.addEventListener('input', () => {
  const query = $searchInput.value.trim().toLowerCase();
  if (!query) { closeSearchDropdown(); return; }

  const results = allNotes.filter(n =>
    !n.deleted &&
    (n.title.toLowerCase().includes(query) ||
    n.content.toLowerCase().includes(query) ||
    (n.tags || []).some(t => t.includes(query)))
  ).slice(0, 12);

  searchSelectedIdx = -1;

  if (results.length === 0) {
    $searchDropdown.innerHTML = '<div class="dropdown-no-results">No notes found</div>';
    $searchDropdown.classList.remove('hidden');
    return;
  }

  $searchDropdown.innerHTML = results.map((note, i) => {
    const titleHtml = highlightMatch(note.title, query);
    let snippet = '';
    const idx = note.content.toLowerCase().indexOf(query);
    if (idx !== -1) {
      const start = Math.max(0, idx - 50);
      const end = Math.min(note.content.length, idx + query.length + 50);
      snippet = (start > 0 ? '...' : '') +
        highlightMatch(note.content.slice(start, end), query) +
        (end < note.content.length ? '...' : '');
    }
    return `<div class="dropdown-result" data-id="${note.id}" data-idx="${i}">
      <div class="dropdown-result-title">${titleHtml}</div>
      ${snippet ? `<div class="dropdown-result-snippet">${snippet}</div>` : ''}
    </div>`;
  }).join('');

  $searchDropdown.classList.remove('hidden');
});

function highlightMatch(text, query) {
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text.replace(new RegExp(`(${escaped})`, 'gi'), '<mark>$1</mark>');
}

// Keyboard navigation in search results
$searchInput.addEventListener('keydown', e => {
  const items = $searchDropdown.querySelectorAll('.dropdown-result');
  if (!items.length) return;

  if (e.key === 'ArrowDown') {
    e.preventDefault();
    searchSelectedIdx = Math.min(searchSelectedIdx + 1, items.length - 1);
    items.forEach((el, i) => el.classList.toggle('selected', i === searchSelectedIdx));
    items[searchSelectedIdx].scrollIntoView({ block: 'nearest' });
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    searchSelectedIdx = Math.max(searchSelectedIdx - 1, 0);
    items.forEach((el, i) => el.classList.toggle('selected', i === searchSelectedIdx));
    items[searchSelectedIdx].scrollIntoView({ block: 'nearest' });
  } else if (e.key === 'Enter') {
    e.preventDefault();
    const target = searchSelectedIdx >= 0 ? items[searchSelectedIdx] : items[0];
    if (target) {
      openNote(target.dataset.id);
      $searchInput.value = '';
      closeSearchDropdown();
      $searchInput.blur();
    }
  }
});

// Click a search result
$searchDropdown.addEventListener('click', e => {
  const result = e.target.closest('.dropdown-result');
  if (!result) return;
  openNote(result.dataset.id);
  $searchInput.value = '';
  closeSearchDropdown();
  $searchInput.blur();
});

// Close dropdown when clicking elsewhere
document.addEventListener('click', e => {
  if (!e.target.closest('#header-search')) {
    closeSearchDropdown();
  }
});

// Mobile search overlay open/close
const $headerSearch = document.getElementById('header-search');
$searchInput.addEventListener('focus', () => {
  if (document.documentElement.getAttribute('data-viewport') === 'mobile') {
    $headerSearch.classList.add('mobile-search-open');
  }
});
$searchInput.addEventListener('blur', () => {
  setTimeout(() => {
    $headerSearch.classList.remove('mobile-search-open');
  }, 150);
});

// ===== Theme Toggle =====
document.getElementById('theme-btn').addEventListener('click', async () => {
  const current = document.documentElement.getAttribute('data-theme');
  const next = current === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  await dbPut('settings', { key: 'theme', value: next });
});

// ===== Viewport Toggle =====
function setViewportMeta(mobile) {
  let meta = document.querySelector('meta[name="viewport"]');
  if (!meta) {
    meta = document.createElement('meta');
    meta.name = 'viewport';
    document.head.appendChild(meta);
  }
  meta.content = mobile
    ? 'width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no'
    : 'width=device-width, initial-scale=1.0';
}

document.getElementById('viewport-btn').addEventListener('click', async () => {
  const html = document.documentElement;
  const isMobile = html.getAttribute('data-viewport') === 'mobile';
  if (isMobile) {
    html.removeAttribute('data-viewport');
    document.getElementById('viewport-btn').innerHTML = '\u{1F4F1}';
    setViewportMeta(false);
    await dbPut('settings', { key: 'viewport', value: 'desktop' });
  } else {
    html.setAttribute('data-viewport', 'mobile');
    document.getElementById('viewport-btn').innerHTML = '\u{1F5A5}';
    setViewportMeta(true);
    setViewMode('view-rich');
    await dbPut('settings', { key: 'viewport', value: 'mobile' });
  }
});

// ===== Export =====
document.getElementById('export-btn').addEventListener('click', () => {
  if (!currentNote) return;
  $exportModal.classList.remove('hidden');
});
document.getElementById('export-close').addEventListener('click', () => {
  $exportModal.classList.add('hidden');
});
$exportModal.addEventListener('click', e => {
  if (e.target === $exportModal) $exportModal.classList.add('hidden');
});

$exportModal.querySelectorAll('.export-option').forEach(btn => {
  btn.addEventListener('click', () => {
    if (!currentNote) return;
    const format = btn.dataset.format;

    if (format === 'pdf') {
      // Ensure preview is visible for print
      const prev = $editorContainer.className;
      $editorContainer.className = 'view-preview';
      updatePreview().then(() => {
        window.print();
        $editorContainer.className = prev;
      });
    } else {
      const blob = new Blob([currentNote.content], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${currentNote.title}.${format}`;
      a.click();
      URL.revokeObjectURL(url);
    }

    $exportModal.classList.add('hidden');
  });
});

// ===== Sidebar Toggle (Mobile) =====
document.getElementById('sidebar-toggle').addEventListener('click', () => {
  $sidebar.classList.toggle('open');
});

// Close sidebar on mobile when clicking a note
$tree.addEventListener('click', e => {
  if ((window.innerWidth <= 768 || document.documentElement.getAttribute('data-viewport') === 'mobile') && e.target.closest('.tree-item[data-type="note"]')) {
    $sidebar.classList.remove('open');
  }
});

// ===== Sidebar Resize =====
const resizeHandle = document.getElementById('sidebar-resize-handle');
let isResizing = false;

resizeHandle.addEventListener('mousedown', e => {
  isResizing = true;
  document.body.style.cursor = 'col-resize';
  document.body.style.userSelect = 'none';
  e.preventDefault();
});

document.addEventListener('mousemove', e => {
  if (!isResizing) return;
  const width = Math.min(500, Math.max(180, e.clientX));
  $sidebar.style.width = width + 'px';
});

document.addEventListener('mouseup', () => {
  if (!isResizing) return;
  isResizing = false;
  document.body.style.cursor = '';
  document.body.style.userSelect = '';
  dbPut('settings', { key: 'sidebarWidth', value: parseInt($sidebar.style.width) });
});

// ===== Setup =====
function setupEventListeners() {
  // Redraw branch map on resize
  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => renderBranchPanel(), 150);
  });
}

// ===== Neural Slab View =====
const $neuralSlab = document.getElementById('neural-slab');

function openSlabView(slabId) {
  currentSlabId = slabId;
  dbPut('settings', { key: 'lastSlab', value: slabId });
  loadCurrentSlab();

  // Show slab, hide editor + venn + kanban
  $editorArea.classList.add('hidden');
  $neuralSlab.classList.remove('hidden');
  $vennView.classList.add('hidden');
  $kanbanView.classList.add('hidden');

  // Update toolbar name
  const board = getCurrentBoard();
  if (board) {
    document.getElementById('slab-toolbar-name').textContent = '\uD83E\uDDE0 ' + board.name;
  }

  // Highlight active slab in tree
  currentNote = null;
  renderTree();
}

function closeSlabView() {
  $neuralSlab.classList.add('hidden');
  $editorArea.classList.remove('hidden');
}

// ===== Neural Slab =====
const $slabCanvas = document.getElementById('slab-canvas');
const $slabSurface = document.getElementById('slab-surface');
const $slabDropHint = document.getElementById('slab-drop-hint');

let allSlabBoards = []; // each board = { id, name, cards: [], pan, zoom }
let currentSlabId = null;
let slabCards = []; // cards on the current board
let slabPan = { x: 0, y: 0 };
let slabZoom = 1;
let slabIsPanning = false;
let slabPanStart = { x: 0, y: 0 };

const SLAB_COLORS = ['#89b4fa', '#a6e3a1', '#f9e2af', '#f38ba8', '#cba6f7', '#74c7ec', '#fab387'];

// ===== Kanban State =====
let allKanbanBoards = [];
let currentKanbanId = null;
let kanbanDragCard = null;
let kanbanDragCol = null;
let kanbanEditCardId = null;
const $kanbanView = document.getElementById('kanban-view');
const $kanbanBoard = document.getElementById('kanban-board');

async function loadSlabs() {
  allSlabBoards = await dbGetAll('slabs') || [];
  renderTree();
}

function getCurrentBoard() {
  return allSlabBoards.find(b => b.id === currentSlabId);
}

function loadCurrentSlab() {
  const board = getCurrentBoard();
  if (!board) return;
  slabCards = board.cards || [];
  slabPan = board.pan || { x: 0, y: 0 };
  slabZoom = board.zoom || 1;
  renderAllSlabCards();
  updateSlabTransform();
}

async function saveCurrentBoard() {
  const board = getCurrentBoard();
  if (!board) return;
  board.cards = slabCards;
  board.pan = slabPan;
  board.zoom = slabZoom;
  await dbPut('slabs', board);
}

async function saveCard(card) {
  const idx = slabCards.findIndex(c => c.id === card.id);
  if (idx >= 0) slabCards[idx] = card;
  else slabCards.push(card);
  await saveCurrentBoard();
}

async function removeCard(id) {
  slabCards = slabCards.filter(c => c.id !== id);
  const el = $slabSurface.querySelector(`[data-slab-id="${id}"]`);
  if (el) el.remove();
  // Remove connections involving this card
  const board = getCurrentBoard();
  if (board && board.connections) {
    board.connections = board.connections.filter(c => c.from !== id && c.to !== id);
  }
  await saveCurrentBoard();
  drawConnections();
}

// New slab from sidebar button
document.getElementById('new-slab-btn').addEventListener('click', async () => {
  const board = { id: uid(), name: 'Untitled Slab', cards: [], pan: { x: 0, y: 0 }, zoom: 1 };
  await dbPut('slabs', board);
  allSlabBoards.push(board);
  renderTree();
  openSlabView(board.id);
});

function createCardData(type, extra = {}) {
  const canvasRect = $slabCanvas.getBoundingClientRect();
  const cx = (canvasRect.width / 2 - slabPan.x) / slabZoom;
  const cy = (canvasRect.height / 2 - slabPan.y) / slabZoom;
  const offsetX = (Math.random() - 0.5) * 100;
  const offsetY = (Math.random() - 0.5) * 80;

  return {
    id: uid(),
    type,
    x: cx + offsetX,
    y: cy + offsetY,
    width: type === 'heading' ? 260 : 220,
    content: '',
    color: SLAB_COLORS[Math.floor(Math.random() * SLAB_COLORS.length)],
    createdAt: Date.now(),
    ...extra
  };
}

function renderAllSlabCards() {
  // Keep the SVG layer, clear cards
  const existingCards = $slabSurface.querySelectorAll('.slab-card');
  existingCards.forEach(el => el.remove());
  for (const card of slabCards) {
    renderSlabCard(card);
  }
  // Draw connections after all cards are in the DOM
  requestAnimationFrame(() => drawConnections());
}

function renderSlabCard(card) {
  const el = document.createElement('div');
  const typeClass = card.type === 'heading' ? ' slab-heading' : card.type === 'image' ? ' slab-image' : card.type === 'notelink' ? ' slab-notelink' : '';
  el.className = 'slab-card' + typeClass;
  el.dataset.slabId = card.id;
  el.style.left = card.x + 'px';
  el.style.top = card.y + 'px';
  if (card.width) el.style.width = card.width + 'px';

  // Header
  const header = document.createElement('div');
  header.className = 'slab-card-header';

  const dot = document.createElement('div');
  dot.className = 'slab-card-color';
  dot.style.background = card.color;

  const title = document.createElement('span');
  title.className = 'slab-card-title';
  const typeLabels = { heading: 'Heading', image: 'Image', notelink: 'Linked Note', text: 'Text' };
  title.textContent = typeLabels[card.type] || 'Text';

  const close = document.createElement('button');
  close.className = 'slab-card-close';
  close.innerHTML = '&times;';
  close.addEventListener('click', e => { e.stopPropagation(); removeCard(card.id); });

  header.append(dot, title, close);

  // Body
  const body = document.createElement('div');
  body.className = 'slab-card-body';

  if (card.type === 'notelink') {
    const note = allNotes.find(n => n.id === card.noteId);
    const noteTitle = note ? note.title : '(deleted note)';
    const snippet = note ? note.content.replace(/^#.*\n*/, '').slice(0, 100) : '';
    body.innerHTML = `<div class="slab-notelink-title"><span class="slab-notelink-icon">\uD83D\uDCC4</span>${escHtml(noteTitle)}</div>` +
      (snippet ? `<div class="slab-notelink-snippet">${escHtml(snippet)}</div>` : '');
    body.addEventListener('click', () => {
      if (!note) return;
      closeSlabView();
      openNote(card.noteId);
    });
  } else if (card.type === 'image') {
    if (card.content) {
      const img = document.createElement('img');
      img.src = card.content;
      body.appendChild(img);
    } else {
      const btn = document.createElement('button');
      btn.textContent = 'Choose Image';
      btn.style.cssText = 'padding:8px 16px;border-radius:6px;background:var(--bg-tertiary);font-size:12px;';
      btn.addEventListener('click', () => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'image/*';
        input.onchange = () => {
          if (!input.files[0]) return;
          const reader = new FileReader();
          reader.onload = () => {
            card.content = reader.result;
            saveCard(card);
            body.innerHTML = '';
            const img = document.createElement('img');
            img.src = card.content;
            body.appendChild(img);
          };
          reader.readAsDataURL(input.files[0]);
        };
        input.click();
      });
      body.appendChild(btn);
    }
  } else {
    const textarea = document.createElement('textarea');
    textarea.value = card.content;
    textarea.placeholder = card.type === 'heading' ? 'Heading...' : 'Write something...';
    textarea.addEventListener('input', () => {
      card.content = textarea.value;
      card.updatedAt = Date.now();
      saveCard(card);
    });
    body.appendChild(textarea);
  }

  // Connector ports
  ['top', 'bottom', 'left', 'right'].forEach(side => {
    const port = document.createElement('div');
    port.className = `slab-card-port port-${side}`;
    port.dataset.side = side;
    port.dataset.cardId = card.id;
    el.appendChild(port);
    setupPortDrag(port, card, el);
  });

  // Resize handle
  const resize = document.createElement('div');
  resize.className = 'slab-card-resize';

  el.append(header, body, resize);
  $slabSurface.appendChild(el);

  setupSlabDrag(el, header, card);
  setupSlabResize(el, resize, card);
}

function escHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function getConnectedGroup(cardId) {
  // Find all cards transitively connected to this card
  const board = getCurrentBoard();
  const connections = board ? (board.connections || []) : [];
  const visited = new Set();
  const queue = [cardId];
  while (queue.length) {
    const id = queue.shift();
    if (visited.has(id)) continue;
    visited.add(id);
    for (const conn of connections) {
      if (conn.from === id && !visited.has(conn.to)) queue.push(conn.to);
      if (conn.to === id && !visited.has(conn.from)) queue.push(conn.from);
    }
  }
  return visited;
}

function setupSlabDrag(cardEl, handle, card) {
  let startX, startY, origPositions;

  handle.addEventListener('mousedown', e => {
    if (e.target.closest('.slab-card-close')) return;
    e.preventDefault();
    e.stopPropagation();
    cardEl.classList.add('dragging');
    startX = e.clientX;
    startY = e.clientY;

    // Snapshot positions of all connected cards
    const group = getConnectedGroup(card.id);
    origPositions = [];
    group.forEach(id => {
      const c = slabCards.find(s => s.id === id);
      const el = $slabSurface.querySelector(`[data-slab-id="${id}"]`);
      if (c && el) origPositions.push({ card: c, el, origX: c.x, origY: c.y });
    });

    const onMove = e => {
      const dx = (e.clientX - startX) / slabZoom;
      const dy = (e.clientY - startY) / slabZoom;
      for (const item of origPositions) {
        item.card.x = item.origX + dx;
        item.card.y = item.origY + dy;
        item.el.style.left = item.card.x + 'px';
        item.el.style.top = item.card.y + 'px';
      }
      drawConnections();
    };

    const onUp = () => {
      cardEl.classList.remove('dragging');
      saveCurrentBoard();
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

function setupSlabResize(cardEl, handle, card) {
  handle.addEventListener('mousedown', e => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const origW = cardEl.offsetWidth;

    const onMove = e => {
      const newW = Math.max(120, origW + (e.clientX - startX) / slabZoom);
      card.width = newW;
      cardEl.style.width = newW + 'px';
      drawConnections();
    };

    const onUp = () => {
      saveCard(card);
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

// ===== Connection Drawing =====
const $slabSvg = document.getElementById('slab-connections');
const $connectLine = document.getElementById('slab-drag-line');
let connectingFrom = null; // { cardId, side }

function setupPortDrag(port, card, cardEl) {
  port.addEventListener('mousedown', e => {
    e.preventDefault();
    e.stopPropagation();

    connectingFrom = { cardId: card.id, side: port.dataset.side };
    port.classList.add('active');

    // Show a live bezier line from this port to cursor
    $connectLine.classList.remove('hidden');
    $connectLine.innerHTML = '';
    const dragPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    dragPath.setAttribute('stroke', 'var(--accent)');
    dragPath.setAttribute('stroke-width', '2.5');
    dragPath.setAttribute('stroke-dasharray', '8 4');
    dragPath.setAttribute('fill', 'none');
    $connectLine.appendChild(dragPath);

    const startPos = getPortCenter(cardEl, port.dataset.side);
    const canvasRect = $slabCanvas.getBoundingClientRect();
    const sx = canvasRect.left + slabPan.x + startPos.x * slabZoom;
    const sy = canvasRect.top + slabPan.y + startPos.y * slabZoom;

    const onMove = e => {
      const ex = e.clientX, ey = e.clientY;
      const dx = Math.abs(ex - sx) * 0.5;
      dragPath.setAttribute('d', `M ${sx} ${sy} C ${sx + dx} ${sy}, ${ex - dx} ${ey}, ${ex} ${ey}`);

      // Highlight target port
      document.querySelectorAll('.slab-card-port.active').forEach(p => {
        if (p !== port) p.classList.remove('active');
      });
      const target = document.elementFromPoint(e.clientX, e.clientY);
      if (target && target.classList.contains('slab-card-port') && target !== port) {
        target.classList.add('active');
      }
    };

    const onUp = e => {
      $connectLine.classList.add('hidden');
      port.classList.remove('active');
      document.querySelectorAll('.slab-card-port.active').forEach(p => p.classList.remove('active'));

      // Check if we dropped on another port
      const target = document.elementFromPoint(e.clientX, e.clientY);
      if (target && target.classList.contains('slab-card-port') && target.dataset.cardId !== card.id) {
        addConnection(card.id, target.dataset.cardId);
      }

      connectingFrom = null;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

function getPortCenter(cardEl, side) {
  const card = slabCards.find(c => c.id === cardEl.dataset.slabId);
  if (!card) return { x: 0, y: 0 };
  const w = cardEl.offsetWidth;
  const h = cardEl.offsetHeight;
  switch (side) {
    case 'top': return { x: card.x + w / 2, y: card.y };
    case 'bottom': return { x: card.x + w / 2, y: card.y + h };
    case 'left': return { x: card.x, y: card.y + h / 2 };
    case 'right': return { x: card.x + w, y: card.y + h / 2 };
  }
  return { x: card.x, y: card.y };
}

function getCardCenter(cardId) {
  const card = slabCards.find(c => c.id === cardId);
  const el = $slabSurface.querySelector(`[data-slab-id="${cardId}"]`);
  if (!card || !el) return { x: 0, y: 0 };
  return { x: card.x + el.offsetWidth / 2, y: card.y + el.offsetHeight / 2 };
}

function getEdgePoint(cardId, targetPos) {
  const card = slabCards.find(c => c.id === cardId);
  const el = $slabSurface.querySelector(`[data-slab-id="${cardId}"]`);
  if (!card || !el) return { x: 0, y: 0 };
  const cx = card.x + el.offsetWidth / 2;
  const cy = card.y + el.offsetHeight / 2;
  const hw = el.offsetWidth / 2;
  const hh = el.offsetHeight / 2;
  const dx = targetPos.x - cx;
  const dy = targetPos.y - cy;
  if (dx === 0 && dy === 0) return { x: cx, y: cy };
  const sx = hw / Math.abs(dx || 1);
  const sy = hh / Math.abs(dy || 1);
  const s = Math.min(sx, sy);
  return { x: cx + dx * s, y: cy + dy * s };
}

const CONN_COLORS = [
  { name: 'Blue', value: '#89b4fa' },
  { name: 'Green', value: '#a6e3a1' },
  { name: 'Yellow', value: '#f9e2af' },
  { name: 'Red', value: '#f38ba8' },
  { name: 'Purple', value: '#cba6f7' },
  { name: 'Teal', value: '#74c7ec' },
  { name: 'Orange', value: '#fab387' },
  { name: 'White', value: '#cdd6f4' }
];

function addConnection(fromId, toId) {
  const board = getCurrentBoard();
  if (!board) return;
  if (!board.connections) board.connections = [];
  if (board.connections.some(c =>
    (c.from === fromId && c.to === toId) || (c.from === toId && c.to === fromId)
  )) return;
  board.connections.push({ id: uid(), from: fromId, to: toId, color: '#89b4fa' });
  saveCurrentBoard();
  drawConnections();
}

function removeConnection(connId) {
  const board = getCurrentBoard();
  if (!board || !board.connections) return;
  board.connections = board.connections.filter(c => c.id !== connId);
  saveCurrentBoard();
  drawConnections();
}

function changeConnectionColor(connId, color) {
  const board = getCurrentBoard();
  if (!board || !board.connections) return;
  const conn = board.connections.find(c => c.id === connId);
  if (conn) { conn.color = color; saveCurrentBoard(); drawConnections(); }
}

function showConnMenu(e, connId) {
  e.preventDefault();
  e.stopPropagation();
  // Remove any existing conn menu
  document.getElementById('conn-menu')?.remove();

  const menu = document.createElement('div');
  menu.id = 'conn-menu';
  menu.className = 'conn-context-menu';
  menu.style.left = e.clientX + 'px';
  menu.style.top = e.clientY + 'px';

  // Color swatches
  const colorRow = document.createElement('div');
  colorRow.className = 'conn-menu-colors';
  for (const c of CONN_COLORS) {
    const swatch = document.createElement('button');
    swatch.className = 'conn-swatch';
    swatch.style.background = c.value;
    swatch.title = c.name;
    swatch.addEventListener('click', () => {
      changeConnectionColor(connId, c.value);
      menu.remove();
    });
    colorRow.appendChild(swatch);
  }
  menu.appendChild(colorRow);

  // Disconnect button
  const disconnectBtn = document.createElement('button');
  disconnectBtn.className = 'conn-menu-btn conn-menu-disconnect';
  disconnectBtn.textContent = 'Disconnect';
  disconnectBtn.addEventListener('click', () => {
    removeConnection(connId);
    menu.remove();
  });
  menu.appendChild(disconnectBtn);

  document.body.appendChild(menu);

  // Close on click elsewhere
  const closeMenu = (ev) => {
    if (!menu.contains(ev.target)) { menu.remove(); document.removeEventListener('mousedown', closeMenu); }
  };
  setTimeout(() => document.addEventListener('mousedown', closeMenu), 0);
}

function toScreen(pt) {
  return { x: slabPan.x + pt.x * slabZoom, y: slabPan.y + pt.y * slabZoom };
}

function drawConnections() {
  const board = getCurrentBoard();
  if (!board) return;
  const connections = board.connections || [];

  $slabSvg.innerHTML = '';

  for (const conn of connections) {
    const fromCenter = getCardCenter(conn.from);
    const toCenter = getCardCenter(conn.to);
    const fromEdge = toScreen(getEdgePoint(conn.from, toCenter));
    const toEdge = toScreen(getEdgePoint(conn.to, fromCenter));
    const color = conn.color || '#89b4fa';

    // Bezier control points (horizontal bias like Blender)
    const dx = Math.abs(toEdge.x - fromEdge.x) * 0.4;
    const d = `M ${fromEdge.x} ${fromEdge.y} C ${fromEdge.x + dx} ${fromEdge.y}, ${toEdge.x - dx} ${toEdge.y}, ${toEdge.x} ${toEdge.y}`;

    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');

    // Glow layer
    const glow = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    glow.setAttribute('d', d);
    glow.setAttribute('stroke', color);
    glow.setAttribute('stroke-width', '8');
    glow.setAttribute('stroke-linecap', 'round');
    glow.setAttribute('fill', 'none');
    glow.setAttribute('opacity', '0.3');
    glow.classList.add('conn-glow');
    g.appendChild(glow);

    // Visible bezier path
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', d);
    path.setAttribute('stroke', color);
    path.setAttribute('stroke-width', '3');
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('fill', 'none');
    path.style.pointerEvents = 'none';
    g.appendChild(path);

    // Invisible hit area path
    const hitPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    hitPath.setAttribute('d', d);
    hitPath.setAttribute('stroke', 'transparent');
    hitPath.setAttribute('stroke-width', '18');
    hitPath.setAttribute('fill', 'none');
    hitPath.style.pointerEvents = 'stroke';
    hitPath.style.cursor = 'pointer';
    g.appendChild(hitPath);

    // Right-click for menu, double-click to disconnect
    hitPath.addEventListener('contextmenu', e => showConnMenu(e, conn.id));
    hitPath.addEventListener('dblclick', e => { e.stopPropagation(); removeConnection(conn.id); });

    // Hover effect — thicken and brighten
    hitPath.addEventListener('mouseenter', () => {
      path.setAttribute('stroke-width', '5');
      glow.setAttribute('opacity', '0.6');
      glow.setAttribute('stroke-width', '14');
    });
    hitPath.addEventListener('mouseleave', () => {
      path.setAttribute('stroke-width', '3');
      glow.setAttribute('opacity', '0.3');
      glow.setAttribute('stroke-width', '8');
    });

    $slabSvg.appendChild(g);
  }
}

// Pan the canvas
$slabCanvas.addEventListener('mousedown', e => {
  if (e.target !== $slabCanvas && e.target !== $slabSurface) return;
  slabIsPanning = true;
  slabPanStart = { x: e.clientX - slabPan.x, y: e.clientY - slabPan.y };
  $slabCanvas.classList.add('grabbing');
});

document.addEventListener('mousemove', e => {
  if (!slabIsPanning) return;
  slabPan.x = e.clientX - slabPanStart.x;
  slabPan.y = e.clientY - slabPanStart.y;
  updateSlabTransform();
});

document.addEventListener('mouseup', () => {
  if (slabIsPanning) {
    slabIsPanning = false;
    $slabCanvas.classList.remove('grabbing');
    saveCurrentBoard();
  }
});

// Zoom with scroll wheel
$slabCanvas.addEventListener('wheel', e => {
  e.preventDefault();
  const rect = $slabCanvas.getBoundingClientRect();
  const mx = e.clientX - rect.left;
  const my = e.clientY - rect.top;

  const oldZoom = slabZoom;
  const delta = e.deltaY > 0 ? 0.9 : 1.1;
  slabZoom = Math.min(3, Math.max(0.2, slabZoom * delta));

  slabPan.x = mx - (mx - slabPan.x) * (slabZoom / oldZoom);
  slabPan.y = my - (my - slabPan.y) * (slabZoom / oldZoom);

  updateSlabTransform();
  saveCurrentBoard();
}, { passive: false });

function updateSlabTransform() {
  $slabSurface.style.transform = `translate(${slabPan.x}px, ${slabPan.y}px) scale(${slabZoom})`;
  document.getElementById('slab-zoom-label').textContent = Math.round(slabZoom * 100) + '%';
  drawConnections();
}

// Zoom buttons
document.getElementById('slab-zoom-in').addEventListener('click', () => {
  slabZoom = Math.min(3, slabZoom * 1.2);
  updateSlabTransform();
  saveCurrentBoard();
});

document.getElementById('slab-zoom-out').addEventListener('click', () => {
  slabZoom = Math.max(0.2, slabZoom * 0.8);
  updateSlabTransform();
  saveCurrentBoard();
});

document.getElementById('slab-zoom-reset').addEventListener('click', () => {
  slabZoom = 1;
  slabPan = { x: 0, y: 0 };
  updateSlabTransform();
  saveCurrentBoard();
});

// Add card buttons
document.getElementById('slab-add-text-btn').addEventListener('click', async () => {
  const card = createCardData('text');
  await saveCard(card);
  renderSlabCard(card);
});

document.getElementById('slab-add-heading-btn').addEventListener('click', async () => {
  const card = createCardData('heading');
  await saveCard(card);
  renderSlabCard(card);
});

document.getElementById('slab-add-image-btn').addEventListener('click', async () => {
  const card = createCardData('image');
  await saveCard(card);
  renderSlabCard(card);
});

// ===== Drag notes from sidebar into Neural Slab =====
function handleSlabDragOver(e) {
  if ($neuralSlab.classList.contains('hidden')) return;
  e.preventDefault();
  e.stopPropagation();
  e.dataTransfer.dropEffect = 'copy';
  $slabDropHint.classList.remove('hidden');
}

function handleSlabDragLeave(e) {
  // Only hide hint if leaving the canvas entirely
  const rect = $slabCanvas.getBoundingClientRect();
  if (e.clientX <= rect.left || e.clientX >= rect.right ||
      e.clientY <= rect.top || e.clientY >= rect.bottom) {
    $slabDropHint.classList.add('hidden');
  }
}

async function handleSlabDrop(e) {
  e.preventDefault();
  e.stopPropagation();
  $slabDropHint.classList.add('hidden');

  // Try dataTransfer first, fall back to dragItem
  let noteId = null;
  try {
    const raw = e.dataTransfer.getData('text/plain');
    if (raw) {
      const data = JSON.parse(raw);
      if (data.type === 'note') noteId = data.id;
    }
  } catch (_) {}

  if (!noteId && dragItem && dragItem.type === 'note') {
    noteId = dragItem.id;
  }

  if (!noteId) return;

  const note = allNotes.find(n => n.id === noteId);
  if (!note) return;

  // Check if this note is already on the slab
  if (slabCards.some(c => c.type === 'notelink' && c.noteId === note.id)) return;

  // Calculate drop position in slab coordinates
  const rect = $slabCanvas.getBoundingClientRect();
  const x = (e.clientX - rect.left - slabPan.x) / slabZoom;
  const y = (e.clientY - rect.top - slabPan.y) / slabZoom;

  const card = createCardData('notelink', {
    noteId: note.id,
    x, y,
    width: 200,
    color: SLAB_COLORS[Math.floor(Math.random() * SLAB_COLORS.length)]
  });

  await saveCard(card);
  renderSlabCard(card);
  dragItem = null;
}

// Listen on both canvas and surface so drops on cards/surface aren't swallowed
// Capture phase so we get the event before any child element can swallow it
$slabCanvas.addEventListener('dragover', handleSlabDragOver, true);
$slabCanvas.addEventListener('dragleave', handleSlabDragLeave, true);
$slabCanvas.addEventListener('drop', handleSlabDrop, true);

// ===== Feature 3: Full Backup Export/Import =====
document.getElementById('backup-btn').addEventListener('click', exportBackup);
document.getElementById('restore-btn').addEventListener('click', () => {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json';
  input.onchange = () => { if (input.files[0]) importBackup(input.files[0]); };
  input.click();
});

async function exportBackup() {
  // Export ALL profiles
  const profiles = getProfiles();
  const allProfileData = {};
  const STORES = ['notes', 'folders', 'slabs', 'kanban', 'images', 'settings'];

  for (const profile of profiles) {
    const pdb = await openDBForProfile(profile.id);
    const profileData = {};
    for (const store of STORES) {
      profileData[store] = await new Promise((resolve, reject) => {
        const tx = pdb.transaction(store, 'readonly');
        const req = tx.objectStore(store).getAll();
        req.onsuccess = () => resolve(req.result);
        req.onerror = e => reject(e.target.error);
      });
    }
    allProfileData[profile.id] = profileData;
    if (pdb !== db) pdb.close();
  }

  const data = {
    version: 2,
    exportedAt: new Date().toISOString(),
    app: 'de-scribe',
    profiles: profiles,
    activeProfile: getActiveProfileId(),
    profileData: allProfileData
  };

  const date = new Date().toISOString().slice(0, 10);
  const defaultName = `de-scribe-backup-${date}`;
  const fileName = prompt('Name your backup file:', defaultName);
  if (!fileName) return;

  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName.endsWith('.json') ? fileName : fileName + '.json';
  a.click();
  URL.revokeObjectURL(url);
  setSaveStatus('saved');
}

async function importBackup(file) {
  const text = await file.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    alert('Invalid backup file — could not parse JSON.');
    return;
  }

  const STORES = ['notes', 'folders', 'slabs', 'kanban', 'images', 'settings'];

  // Handle legacy v1 backups (no profiles)
  if (!data.profiles) {
    if (!data.notes || !data.folders) {
      alert('Invalid backup file — missing required data.');
      return;
    }
    if (!confirm('This will replace the current profile\'s data. Continue?')) return;

    for (const store of STORES) await dbClearStore(store);
    for (const note of (data.notes || [])) await dbPut('notes', note);
    for (const folder of (data.folders || [])) await dbPut('folders', folder);
    for (const slab of (data.slabs || [])) await dbPut('slabs', slab);
    for (const kb of (data.kanban || [])) await dbPut('kanban', kb);
    for (const image of (data.images || [])) await dbPut('images', image);
    for (const setting of (data.settings || [])) await dbPut('settings', setting);

    allNotes = await dbGetAll('notes');
    allFolders = await dbGetAll('folders');
    allSlabBoards = await dbGetAll('slabs') || [];
    allKanbanBoards = await dbGetAll('kanban') || [];
    currentNote = null;
    renderTree();
    setEditorState(false);
    setSaveStatus('saved');
    alert('Backup restored successfully!');
    return;
  }

  // Multi-profile backup (v2)
  const profileCount = data.profiles.length;
  if (!confirm(`This backup contains ${profileCount} profile(s). This will replace ALL profiles and data. Continue?`)) return;

  // Restore profile list
  saveProfiles(data.profiles);
  setActiveProfileId(data.activeProfile || data.profiles[0].id);

  // Restore each profile's data
  for (const profile of data.profiles) {
    const pdb = await openDBForProfile(profile.id);
    const pd = data.profileData[profile.id] || {};

    for (const store of STORES) {
      await new Promise((resolve, reject) => {
        const tx = pdb.transaction(store, 'readwrite');
        tx.objectStore(store).clear();
        tx.oncomplete = () => resolve();
        tx.onerror = e => reject(e.target.error);
      });
      for (const item of (pd[store] || [])) {
        await new Promise((resolve, reject) => {
          const tx = pdb.transaction(store, 'readwrite');
          tx.objectStore(store).put(item);
          tx.oncomplete = () => resolve();
          tx.onerror = e => reject(e.target.error);
        });
      }
    }
    if (pdb !== db) pdb.close();
  }

  // Reload into the active profile
  await switchProfile(getActiveProfileId());
  alert(`Restored ${profileCount} profile(s) successfully!`);
}

// ===== Feature 4: Tag System =====
function getAllTags() {
  const tags = new Set();
  for (const note of allNotes) {
    if (note.deleted) continue;
    for (const tag of (note.tags || [])) {
      tags.add(tag);
    }
  }
  return [...tags].sort();
}

function renderTagBar() {
  if (!currentNote) {
    $tagBar.classList.add('hidden');
    return;
  }
  $tagBar.classList.remove('hidden');
  $tagChips.innerHTML = '';
  const tags = currentNote.tags || [];
  tags.forEach(tag => {
    const chip = document.createElement('span');
    chip.className = 'tag-chip';
    chip.textContent = tag;
    const remove = document.createElement('span');
    remove.className = 'tag-chip-remove';
    remove.innerHTML = '&times;';
    remove.addEventListener('click', async () => {
      currentNote.tags = (currentNote.tags || []).filter(t => t !== tag);
      await dbPut('notes', currentNote);
      renderTagBar();
      renderTagFilterBar();
    });
    chip.appendChild(remove);
    $tagChips.appendChild(chip);
  });
}

function addTag(tag) {
  if (!currentNote) return;
  tag = tag.toLowerCase().trim();
  if (!tag) return;
  if (!currentNote.tags) currentNote.tags = [];
  if (currentNote.tags.includes(tag)) return;
  currentNote.tags.push(tag);
  dbPut('notes', currentNote);
  renderTagBar();
  renderTagFilterBar();
}

$tagInput.addEventListener('keydown', e => {
  if (e.key === 'Enter' || e.key === ',') {
    e.preventDefault();
    const val = $tagInput.value.replace(/,/g, '').trim();
    if (val) addTag(val);
    $tagInput.value = '';
    hideTagAutocomplete();
  }
  if (e.key === 'Backspace' && !$tagInput.value && currentNote && currentNote.tags && currentNote.tags.length) {
    currentNote.tags.pop();
    dbPut('notes', currentNote);
    renderTagBar();
    renderTagFilterBar();
  }
  if (e.key === 'Escape') hideTagAutocomplete();
});

$tagInput.addEventListener('input', () => {
  const val = $tagInput.value.toLowerCase().trim();
  if (!val) { hideTagAutocomplete(); return; }
  const existing = getAllTags().filter(t => t.includes(val) && !(currentNote.tags || []).includes(t));
  if (!existing.length) { hideTagAutocomplete(); return; }
  $tagAutocomplete.innerHTML = '';
  existing.slice(0, 8).forEach(tag => {
    const item = document.createElement('div');
    item.className = 'tag-autocomplete-item';
    item.textContent = tag;
    item.addEventListener('click', () => {
      addTag(tag);
      $tagInput.value = '';
      hideTagAutocomplete();
    });
    $tagAutocomplete.appendChild(item);
  });
  $tagAutocomplete.classList.remove('hidden');
});

function hideTagAutocomplete() {
  $tagAutocomplete.classList.add('hidden');
  $tagAutocomplete.innerHTML = '';
}

function renderTagFilterBar() {
  const tags = getAllTags();
  if (!tags.length) {
    $tagFilterWrapper.classList.add('hidden');
    return;
  }
  $tagFilterWrapper.classList.remove('hidden');
  $tagFilterBar.innerHTML = '';
  tags.forEach(tag => {
    const chip = document.createElement('button');
    chip.className = 'tag-filter-chip' + (activeTagFilter === tag ? ' active' : '');
    chip.textContent = tag;
    chip.addEventListener('click', () => {
      activeTagFilter = activeTagFilter === tag ? null : tag;
      renderTree();
    });
    $tagFilterBar.appendChild(chip);
  });
}

// ===== Feature 5: Clipboard Image Paste (Slab) =====
document.addEventListener('paste', e => {
  // Only handle if slab is visible and editor is not focused
  if ($neuralSlab.classList.contains('hidden')) return;
  if (document.activeElement === $editor) return;
  const items = e.clipboardData?.items;
  if (!items) return;
  for (const item of items) {
    if (item.type.startsWith('image/')) {
      e.preventDefault();
      const file = item.getAsFile();
      const reader = new FileReader();
      reader.onload = async () => {
        const card = createCardData('image');
        card.content = reader.result;
        await saveCard(card);
        renderSlabCard(card);
      };
      reader.readAsDataURL(file);
      return;
    }
  }
});

// ===== Feature 6: Color-Coded Folders =====
function showFolderColorPicker(folderId) {
  const folder = allFolders.find(f => f.id === folderId);
  if (!folder) return;

  // Position near the context menu
  $folderColorPicker.style.left = $contextMenu.style.left;
  $folderColorPicker.style.top = (parseInt($contextMenu.style.top) + 40) + 'px';
  $folderColorPicker.innerHTML = '';
  $folderColorPicker.classList.remove('hidden');

  // "No color" swatch
  const noColor = document.createElement('button');
  noColor.className = 'folder-color-swatch no-color';
  noColor.title = 'No color';
  noColor.addEventListener('click', async () => {
    folder.color = null;
    await dbPut('folders', folder);
    renderTree();
    $folderColorPicker.classList.add('hidden');
  });
  $folderColorPicker.appendChild(noColor);

  SLAB_COLORS.forEach(color => {
    const swatch = document.createElement('button');
    swatch.className = 'folder-color-swatch';
    swatch.style.background = color;
    swatch.title = color;
    swatch.addEventListener('click', async () => {
      folder.color = color;
      await dbPut('folders', folder);
      renderTree();
      $folderColorPicker.classList.add('hidden');
    });
    $folderColorPicker.appendChild(swatch);
  });

  // Close on click elsewhere
  const close = e => {
    if (!$folderColorPicker.contains(e.target)) {
      $folderColorPicker.classList.add('hidden');
      document.removeEventListener('mousedown', close);
    }
  };
  setTimeout(() => document.addEventListener('mousedown', close), 0);
}

// ===== Feature 7: Word Count Goals =====
$wordCountWrapper.addEventListener('click', e => {
  if (!currentNote) return;
  // Don't trigger when clicking on existing input
  if (e.target.tagName === 'INPUT') return;
  const existing = $wordCountWrapper.querySelector('#word-goal-input');
  if (existing) return;

  const input = document.createElement('input');
  input.id = 'word-goal-input';
  input.type = 'number';
  input.placeholder = 'Goal';
  input.min = '0';
  input.value = currentNote.wordGoal || '';
  $wordCountWrapper.appendChild(input);
  input.focus();
  input.select();

  const finish = async () => {
    const val = parseInt(input.value);
    currentNote.wordGoal = val > 0 ? val : null;
    await dbPut('notes', currentNote);
    input.remove();
    updateWordCount();
  };

  input.addEventListener('blur', finish);
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') input.blur();
    if (e.key === 'Escape') { input.value = ''; input.blur(); }
  });
});

// ===== Feature 8: WYSIWYG Toggle =====
let turndownService = null;

function getTurndown() {
  if (turndownService) return turndownService;
  if (typeof TurndownService === 'undefined') return null;
  turndownService = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
  // Custom rule for wiki links
  turndownService.addRule('wikiLinks', {
    filter: node => node.classList && node.classList.contains('wiki-link'),
    replacement: (content) => `[[${content}]]`
  });
  // Custom rule for branch markers
  turndownService.addRule('branchMarkers', {
    filter: node => node.classList && node.classList.contains('branch-marker'),
    replacement: () => ''
  });

  // Table support: keep tables intact when converting HTML back to markdown
  turndownService.addRule('tableCell', {
    filter: ['th', 'td'],
    replacement: (content, node) => {
      const trimmed = content.replace(/\n/g, ' ').trim();
      return ' ' + trimmed + ' |';
    }
  });
  turndownService.addRule('tableRow', {
    filter: 'tr',
    replacement: (content, node) => {
      let row = '|' + content + '\n';
      // If this is the first row in a thead, or the first row of the table, add separator
      const parent = node.parentNode;
      const isHeaderRow = parent.nodeName === 'THEAD' ||
        (parent.nodeName === 'TABLE' && parent.rows[0] === node) ||
        (parent.nodeName === 'TBODY' && !node.previousElementSibling && !parent.previousElementSibling);
      if (isHeaderRow) {
        const cellCount = node.cells ? node.cells.length : (content.match(/\|/g) || []).length;
        row += '|' + ' --- |'.repeat(cellCount) + '\n';
      }
      return row;
    }
  });
  turndownService.addRule('table', {
    filter: 'table',
    replacement: (content) => {
      return '\n\n' + content.trim() + '\n\n';
    }
  });
  turndownService.addRule('tableSection', {
    filter: ['thead', 'tbody', 'tfoot'],
    replacement: (content) => content
  });

  return turndownService;
}

document.getElementById('view-rich').addEventListener('click', () => {
  if (!getTurndown()) {
    alert('Turndown.js is still loading. Please try again.');
    return;
  }
  setViewMode('view-rich');
});

// ===== Venn Diagram View =====
const $vennView = document.getElementById('venn-view');
const $vennSvg = document.getElementById('venn-svg');
const $vennFolderToggles = document.getElementById('venn-folder-toggles');
const $vennTagSelector = document.getElementById('venn-tag-selector');
const $vennTooltip = document.getElementById('venn-tooltip');
const $vennEmpty = document.getElementById('venn-empty');

const $vennTagHeader = document.getElementById('venn-tag-selector-header');

let vennSelectedTags = [];
let vennEnabledFolders = new Set();

// Collapsible tag selector
$vennTagHeader.addEventListener('click', () => {
  $vennTagHeader.classList.toggle('expanded');
  $vennTagSelector.classList.toggle('collapsed');
});

function openVennView() {
  $editorArea.classList.add('hidden');
  $neuralSlab.classList.add('hidden');
  $kanbanView.classList.add('hidden');
  $vennView.classList.remove('hidden');

  // Enable all folders + root by default
  vennEnabledFolders = new Set(allFolders.map(f => f.id));
  vennEnabledFolders.add('__root__');

  vennSelectedTags = [];
  // Expand tag selector on open
  $vennTagHeader.classList.add('expanded');
  $vennTagSelector.classList.remove('collapsed');
  renderVennFolderToggles();
  renderVennTagSelector();
  renderVennDiagram();
}

function closeVennView() {
  $vennView.classList.add('hidden');
  $editorArea.classList.remove('hidden');
}

document.getElementById('venn-btn').addEventListener('click', () => {
  if ($vennView.classList.contains('hidden')) {
    openVennView();
  } else {
    closeVennView();
  }
});

function renderVennFolderToggles() {
  $vennFolderToggles.innerHTML = '';

  // Unfiled pseudo-folder
  const items = [{ id: '__root__', name: '\u{1F4C4} Unfiled' }, ...allFolders.map(f => ({ id: f.id, name: '\u{1F4C1} ' + f.name }))];
  items.forEach(f => {
    const label = document.createElement('label');
    label.className = 'venn-folder-toggle';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = vennEnabledFolders.has(f.id);
    cb.addEventListener('change', () => {
      if (cb.checked) vennEnabledFolders.add(f.id);
      else vennEnabledFolders.delete(f.id);
      renderVennDiagram();
    });
    label.appendChild(cb);
    label.appendChild(document.createTextNode(f.name));
    $vennFolderToggles.appendChild(label);
  });
}

function renderVennTagSelector() {
  $vennTagSelector.innerHTML = '';
  const tags = getAllTags();
  const atLimit = vennSelectedTags.length >= 8;

  tags.forEach(tag => {
    const isSelected = vennSelectedTags.includes(tag);
    const idx = vennSelectedTags.indexOf(tag);

    const label = document.createElement('label');
    label.className = 'venn-tag-item';
    if (atLimit && !isSelected) label.classList.add('disabled');

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = isSelected;
    cb.addEventListener('change', () => {
      if (cb.checked && vennSelectedTags.length < 8) {
        vennSelectedTags.push(tag);
      } else {
        vennSelectedTags = vennSelectedTags.filter(t => t !== tag);
      }
      renderVennTagSelector();
      renderVennDiagram();
    });

    const dot = document.createElement('span');
    dot.className = 'venn-tag-color';
    dot.style.background = isSelected ? SLAB_COLORS[idx % SLAB_COLORS.length] : 'transparent';

    label.appendChild(cb);
    label.appendChild(dot);
    label.appendChild(document.createTextNode(tag));
    $vennTagSelector.appendChild(label);
  });
}

function getVennLayout(count) {
  switch (count) {
    case 2: return [
      { cx: 0.38, cy: 0.5, r: 0.28 },
      { cx: 0.62, cy: 0.5, r: 0.28 }
    ];
    case 3: return [
      { cx: 0.5, cy: 0.35, r: 0.25 },
      { cx: 0.35, cy: 0.6, r: 0.25 },
      { cx: 0.65, cy: 0.6, r: 0.25 }
    ];
    case 4: return [
      { cx: 0.38, cy: 0.38, r: 0.23 },
      { cx: 0.62, cy: 0.38, r: 0.23 },
      { cx: 0.38, cy: 0.62, r: 0.23 },
      { cx: 0.62, cy: 0.62, r: 0.23 }
    ];
    default: {
      if (count < 2 || count > 8) return [];
      const out = [];
      const spread = count <= 5 ? 0.18 : count <= 6 ? 0.20 : 0.22;
      const r = count <= 5 ? 0.22 : count <= 6 ? 0.20 : 0.18;
      for (let i = 0; i < count; i++) {
        const angle = (i / count) * Math.PI * 2 - Math.PI / 2;
        out.push({ cx: 0.5 + spread * Math.cos(angle), cy: 0.5 + spread * Math.sin(angle), r });
      }
      return out;
    }
  }
}

function getVennNotes() {
  return allNotes.filter(n => {
    if (n.deleted) return false;
    const fid = n.folderId || '__root__';
    if (!vennEnabledFolders.has(fid)) return false;
    const noteTags = n.tags || [];
    return vennSelectedTags.some(t => noteTags.includes(t));
  });
}

function getRegionCenter(matchingTags, circles) {
  let cx = 0, cy = 0;
  matchingTags.forEach(tag => {
    const idx = vennSelectedTags.indexOf(tag);
    if (idx >= 0) { cx += circles[idx].cx; cy += circles[idx].cy; }
  });
  cx /= matchingTags.length;
  cy /= matchingTags.length;
  return { cx, cy };
}

function distributeDotsAroundCenter(cx, cy, count, spread) {
  if (count === 1) return [{ x: cx, y: cy }];
  const golden = Math.PI * (3 - Math.sqrt(5));
  const points = [];
  for (let i = 0; i < count; i++) {
    const r = spread * Math.sqrt((i + 0.5) / count);
    const theta = i * golden;
    points.push({ x: cx + r * Math.cos(theta), y: cy + r * Math.sin(theta) });
  }
  return points;
}

function showVennTooltip(evt, note) {
  const snippet = (note.content || '').replace(/[#*_`>\[\]]/g, '').slice(0, 120);
  const tags = (note.tags || []).map(t => `<span class="venn-tooltip-tag">${escHtml(t)}</span>`).join('');
  $vennTooltip.innerHTML =
    `<div class="venn-tooltip-title">${escHtml(note.title || 'Untitled')}</div>` +
    `<div class="venn-tooltip-snippet">${escHtml(snippet)}${note.content && note.content.length > 120 ? '...' : ''}</div>` +
    `<div class="venn-tooltip-tags">${tags}</div>`;

  const rect = $vennSvg.parentElement.getBoundingClientRect();
  let x = evt.clientX - rect.left + 14;
  let y = evt.clientY - rect.top + 14;
  if (x + 280 > rect.width) x = evt.clientX - rect.left - 290;
  if (y + 120 > rect.height) y = evt.clientY - rect.top - 130;
  $vennTooltip.style.left = Math.max(0, x) + 'px';
  $vennTooltip.style.top = Math.max(0, y) + 'px';
  $vennTooltip.classList.remove('hidden');
}

function renderVennDiagram() {
  $vennSvg.innerHTML = '';

  if (vennSelectedTags.length < 2) {
    $vennEmpty.classList.remove('hidden');
    return;
  }
  $vennEmpty.classList.add('hidden');

  const rect = $vennSvg.parentElement.getBoundingClientRect();
  const W = rect.width || 600;
  const H = rect.height || 500;
  $vennSvg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  $vennSvg.setAttribute('width', W);
  $vennSvg.setAttribute('height', H);

  const layout = getVennLayout(vennSelectedTags.length);
  const circles = layout.map((c, i) => ({
    cx: c.cx * W, cy: c.cy * H, r: c.r * Math.min(W, H),
    color: SLAB_COLORS[i % SLAB_COLORS.length], tag: vennSelectedTags[i]
  }));

  const ns = 'http://www.w3.org/2000/svg';

  // Draw circles
  circles.forEach(c => {
    const el = document.createElementNS(ns, 'circle');
    el.setAttribute('cx', c.cx);
    el.setAttribute('cy', c.cy);
    el.setAttribute('r', c.r);
    el.setAttribute('fill', c.color);
    el.setAttribute('fill-opacity', '0.2');
    el.setAttribute('stroke', c.color);
    el.setAttribute('stroke-width', '2');
    el.classList.add('venn-circle');
    $vennSvg.appendChild(el);
  });

  // Draw labels
  circles.forEach(c => {
    const txt = document.createElementNS(ns, 'text');
    txt.setAttribute('x', c.cx);
    txt.setAttribute('y', c.cy - c.r - 8);
    txt.classList.add('venn-label');
    txt.textContent = c.tag;
    $vennSvg.appendChild(txt);
  });

  // Classify notes into regions
  const notes = getVennNotes();
  const regions = {};
  notes.forEach(note => {
    const noteTags = note.tags || [];
    const matching = vennSelectedTags.filter(t => noteTags.includes(t));
    if (matching.length === 0) return;
    const key = matching.sort().join(',');
    if (!regions[key]) regions[key] = { tags: matching, notes: [] };
    regions[key].notes.push(note);
  });

  // Draw note dots per region
  const dotRadius = 6;
  const spread = Math.min(W, H) * 0.04;

  Object.values(regions).forEach(region => {
    const center = getRegionCenter(region.tags, circles);
    const points = distributeDotsAroundCenter(center.cx, center.cy, region.notes.length, spread);

    region.notes.forEach((note, i) => {
      const dot = document.createElementNS(ns, 'circle');
      dot.setAttribute('cx', points[i].x);
      dot.setAttribute('cy', points[i].y);
      dot.setAttribute('r', dotRadius);

      // Color: blend of matching tag colors
      const matchIdx = vennSelectedTags.indexOf(region.tags[0]);
      dot.setAttribute('fill', SLAB_COLORS[matchIdx % SLAB_COLORS.length]);
      dot.setAttribute('fill-opacity', '0.85');
      dot.classList.add('venn-note-dot');

      dot.addEventListener('mouseenter', e => showVennTooltip(e, note));
      dot.addEventListener('mousemove', e => showVennTooltip(e, note));
      dot.addEventListener('mouseleave', () => $vennTooltip.classList.add('hidden'));
      dot.addEventListener('click', () => {
        closeVennView();
        openNote(note.id);
      });

      $vennSvg.appendChild(dot);
    });
  });
}

// Integrate with existing views
window.addEventListener('resize', () => {
  if (!$vennView.classList.contains('hidden')) renderVennDiagram();
});

// ===== Kanban Board =====

function getCurrentKanbanBoard() {
  return allKanbanBoards.find(b => b.id === currentKanbanId);
}

async function saveCurrentKanbanBoard() {
  const board = getCurrentKanbanBoard();
  if (board) await dbPut('kanban', board);
}

function openKanbanView(boardId) {
  currentKanbanId = boardId;
  $editorArea.classList.add('hidden');
  $neuralSlab.classList.add('hidden');
  $vennView.classList.add('hidden');
  $kanbanView.classList.remove('hidden');

  const board = getCurrentKanbanBoard();
  if (board) {
    document.getElementById('kanban-toolbar-name').textContent = '\u2610 ' + board.name;
  }
  currentNote = null;
  renderKanbanBoard();
  renderTree();
}

function closeKanbanView() {
  $kanbanView.classList.add('hidden');
  $editorArea.classList.remove('hidden');
  currentKanbanId = null;
  renderTree();
}

// Toolbar name double-click to rename
document.getElementById('kanban-toolbar-name').addEventListener('dblclick', () => {
  const board = getCurrentKanbanBoard();
  if (!board) return;
  const newName = prompt('Rename board:', board.name);
  if (newName && newName.trim()) {
    board.name = newName.trim();
    saveCurrentKanbanBoard();
    document.getElementById('kanban-toolbar-name').textContent = '\u2610 ' + board.name;
    renderTree();
  }
});

// New kanban board button
document.getElementById('new-kanban-btn').addEventListener('click', async () => {
  const board = {
    id: uid(),
    name: 'Untitled Board',
    folderId: null,
    sortOrder: allKanbanBoards.length,
    createdAt: Date.now(),
    columns: [
      { id: uid(), name: 'To Do', sortOrder: 0, color: SLAB_COLORS[0] },
      { id: uid(), name: 'In Progress', sortOrder: 1, color: SLAB_COLORS[1] },
      { id: uid(), name: 'Done', sortOrder: 2, color: SLAB_COLORS[2] }
    ],
    cards: []
  };
  await dbPut('kanban', board);
  allKanbanBoards.push(board);
  renderTree();
  openKanbanView(board.id);
});

// Add column
document.getElementById('kanban-add-col-btn').addEventListener('click', async () => {
  const board = getCurrentKanbanBoard();
  if (!board) return;
  const name = prompt('Column name:');
  if (!name || !name.trim()) return;
  const colorIdx = board.columns.length % SLAB_COLORS.length;
  board.columns.push({ id: uid(), name: name.trim(), sortOrder: board.columns.length, color: SLAB_COLORS[colorIdx] });
  await saveCurrentKanbanBoard();
  renderKanbanBoard();
});

function renderKanbanBoard() {
  const board = getCurrentKanbanBoard();
  if (!board) { $kanbanBoard.innerHTML = ''; return; }

  $kanbanBoard.innerHTML = '';
  const sortedCols = [...board.columns].sort((a, b) => a.sortOrder - b.sortOrder);

  sortedCols.forEach(col => {
    const colEl = document.createElement('div');
    colEl.className = 'kanban-column';
    colEl.style.borderTopColor = col.color || SLAB_COLORS[0];
    colEl.dataset.columnId = col.id;

    const colCards = board.cards
      .filter(c => c.columnId === col.id)
      .sort((a, b) => a.sortOrder - b.sortOrder);

    // Header
    const header = document.createElement('div');
    header.className = 'kanban-column-header';

    const nameInput = document.createElement('input');
    nameInput.className = 'kanban-col-name';
    nameInput.value = col.name;
    nameInput.addEventListener('blur', async () => {
      const newName = nameInput.value.trim() || col.name;
      col.name = newName;
      await saveCurrentKanbanBoard();
    });
    nameInput.addEventListener('keydown', e => { if (e.key === 'Enter') nameInput.blur(); });

    const count = document.createElement('span');
    count.className = 'kanban-col-count';
    count.textContent = colCards.length;

    const delBtn = document.createElement('button');
    delBtn.className = 'kanban-col-delete';
    delBtn.innerHTML = '&times;';
    delBtn.title = 'Delete column';
    delBtn.addEventListener('click', async () => {
      if (colCards.length > 0 && !confirm(`Delete "${col.name}" and its ${colCards.length} card(s)?`)) return;
      board.columns = board.columns.filter(c => c.id !== col.id);
      board.cards = board.cards.filter(c => c.columnId !== col.id);
      await saveCurrentKanbanBoard();
      renderKanbanBoard();
    });

    // Make column draggable via header
    const dragHandle = document.createElement('span');
    dragHandle.className = 'kanban-col-drag';
    dragHandle.textContent = '\u2630';
    dragHandle.title = 'Drag to reorder';
    header.append(dragHandle, nameInput, count, delBtn);

    // Track whether mousedown was on the drag handle
    let colDragAllowed = false;
    dragHandle.addEventListener('mousedown', () => { colDragAllowed = true; });
    document.addEventListener('mouseup', () => { colDragAllowed = false; }, { passive: true });

    colEl.draggable = true;
    colEl.addEventListener('dragstart', e => {
      if (!colDragAllowed) {
        e.preventDefault();
        return;
      }
      kanbanDragCol = col.id;
      colEl.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    });
    colEl.addEventListener('dragend', () => {
      colEl.classList.remove('dragging');
      kanbanDragCol = null;
      document.querySelectorAll('.kanban-column.col-drag-over').forEach(c => c.classList.remove('col-drag-over'));
    });
    colEl.addEventListener('dragover', e => {
      if (kanbanDragCol && kanbanDragCol !== col.id) {
        e.preventDefault();
        e.stopPropagation();
        colEl.classList.add('col-drag-over');
      }
    });
    colEl.addEventListener('dragleave', e => {
      if (!colEl.contains(e.relatedTarget)) {
        colEl.classList.remove('col-drag-over');
      }
    });
    colEl.addEventListener('drop', async e => {
      if (kanbanDragCol && kanbanDragCol !== col.id) {
        e.preventDefault();
        e.stopPropagation();
        colEl.classList.remove('col-drag-over');

        // Reorder: move dragged column to this column's position
        const sorted = [...board.columns].sort((a, b) => a.sortOrder - b.sortOrder);
        const dragIdx = sorted.findIndex(c => c.id === kanbanDragCol);
        const targetIdx = sorted.findIndex(c => c.id === col.id);
        if (dragIdx !== -1 && targetIdx !== -1) {
          const [moved] = sorted.splice(dragIdx, 1);
          sorted.splice(targetIdx, 0, moved);
          sorted.forEach((c, i) => c.sortOrder = i);
          await saveCurrentKanbanBoard();
          renderKanbanBoard();
        }
      }
    });

    // Body (card list)
    const body = document.createElement('div');
    body.className = 'kanban-column-body';
    body.dataset.columnId = col.id;

    colCards.forEach(card => {
      body.appendChild(createKanbanCardEl(card));
    });

    // Drag-and-drop on body
    body.addEventListener('dragover', e => {
      // For column drags, let the event bubble to the column handler
      if (kanbanDragCol) return;
      e.preventDefault();
      // Handle kanban card drag
      if (kanbanDragCard) {
        colEl.classList.add('drag-over');
        // Remove old placeholder
        body.querySelectorAll('.kanban-drop-placeholder').forEach(p => p.remove());
        const placeholder = document.createElement('div');
        placeholder.className = 'kanban-drop-placeholder';

        const cardEls = [...body.querySelectorAll('.kanban-card:not(.dragging)')];
        let inserted = false;
        for (const ce of cardEls) {
          const rect = ce.getBoundingClientRect();
          if (e.clientY < rect.top + rect.height / 2) {
            body.insertBefore(placeholder, ce);
            inserted = true;
            break;
          }
        }
        if (!inserted) body.appendChild(placeholder);
      }
      // Handle note drag from tree
      if (dragItem && dragItem.type === 'note') {
        e.dataTransfer.dropEffect = 'link';
      }
    });

    body.addEventListener('dragleave', e => {
      if (!body.contains(e.relatedTarget)) {
        colEl.classList.remove('drag-over');
        body.querySelectorAll('.kanban-drop-placeholder').forEach(p => p.remove());
      }
    });

    body.addEventListener('drop', async e => {
      e.preventDefault();
      colEl.classList.remove('drag-over');
      body.querySelectorAll('.kanban-drop-placeholder').forEach(p => p.remove());

      // Handle kanban card drop
      if (kanbanDragCard) {
        e.stopPropagation();
        const card = board.cards.find(c => c.id === kanbanDragCard.cardId);
        if (card) {
          card.columnId = col.id;
          // Calculate insertion index
          const cardEls = [...body.querySelectorAll('.kanban-card:not(.dragging)')];
          let insertIdx = cardEls.length;
          for (let i = 0; i < cardEls.length; i++) {
            const rect = cardEls[i].getBoundingClientRect();
            if (e.clientY < rect.top + rect.height / 2) {
              insertIdx = i;
              break;
            }
          }
          // Reorder cards in this column
          const colCardsNow = board.cards
            .filter(c => c.columnId === col.id && c.id !== card.id)
            .sort((a, b) => a.sortOrder - b.sortOrder);
          colCardsNow.splice(insertIdx, 0, card);
          colCardsNow.forEach((c, i) => c.sortOrder = i);
          await saveCurrentKanbanBoard();
          renderKanbanBoard();
        }
        return;
      }

      // Handle note drop from tree onto column body — link to no specific card, ignore
    });

    // Footer
    const footer = document.createElement('div');
    footer.className = 'kanban-column-footer';
    const addBtn = document.createElement('button');
    addBtn.textContent = '+ Add card';
    addBtn.addEventListener('click', async () => {
      const card = {
        id: uid(),
        columnId: col.id,
        title: 'New Card',
        description: '',
        createdAt: Date.now(),
        dueDate: null,
        sortOrder: colCards.length,
        linkedNoteIds: []
      };
      board.cards.push(card);
      await saveCurrentKanbanBoard();
      renderKanbanBoard();
    });
    footer.appendChild(addBtn);

    colEl.append(header, body, footer);
    $kanbanBoard.appendChild(colEl);
  });
}

function createKanbanCardEl(card) {
  const el = document.createElement('div');
  el.className = 'kanban-card';
  el.draggable = true;
  el.dataset.cardId = card.id;

  const title = document.createElement('div');
  title.className = 'kanban-card-title';
  title.textContent = card.title;
  el.appendChild(title);

  // Meta row
  const meta = document.createElement('div');
  meta.className = 'kanban-card-meta';
  if (card.dueDate) {
    const dueSpan = document.createElement('span');
    const dueDate = new Date(card.dueDate);
    const now = new Date();
    now.setHours(0, 0, 0, 0);
    const isOverdue = dueDate < now;
    dueSpan.textContent = '\uD83D\uDCC5 ' + dueDate.toLocaleDateString();
    if (isOverdue) dueSpan.className = 'kanban-card-overdue';
    meta.appendChild(dueSpan);
  }
  if (card.linkedNoteIds && card.linkedNoteIds.length > 0) {
    const linkSpan = document.createElement('span');
    linkSpan.textContent = '\uD83D\uDD17 ' + card.linkedNoteIds.length;
    meta.appendChild(linkSpan);
  }
  if (meta.childNodes.length > 0) el.appendChild(meta);

  // Click to open modal
  el.addEventListener('click', e => {
    if (el.classList.contains('dragging')) return;
    openKanbanCardModal(card.id);
  });

  // Drag start/end for card
  el.addEventListener('dragstart', e => {
    kanbanDragCard = { cardId: card.id, sourceColumnId: card.columnId };
    el.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.stopPropagation();
  });

  el.addEventListener('dragend', () => {
    el.classList.remove('dragging');
    kanbanDragCard = null;
    document.querySelectorAll('.kanban-column.drag-over').forEach(c => c.classList.remove('drag-over'));
    document.querySelectorAll('.kanban-drop-placeholder').forEach(p => p.remove());
  });

  // Accept note drops from sidebar tree onto card
  el.addEventListener('dragover', e => {
    if (dragItem && dragItem.type === 'note') {
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'link';
      el.style.outline = '2px solid var(--accent)';
    }
  });

  el.addEventListener('dragleave', () => {
    el.style.outline = '';
  });

  el.addEventListener('drop', async e => {
    el.style.outline = '';
    if (dragItem && dragItem.type === 'note') {
      e.preventDefault();
      e.stopPropagation();
      const board = getCurrentKanbanBoard();
      const boardCard = board.cards.find(c => c.id === card.id);
      if (boardCard && !boardCard.linkedNoteIds.includes(dragItem.id)) {
        boardCard.linkedNoteIds.push(dragItem.id);
        await saveCurrentKanbanBoard();
        renderKanbanBoard();
      }
    }
  });

  return el;
}

// ===== Kanban Card Modal =====
const $kanbanCardModal = document.getElementById('kanban-card-modal');

function openKanbanCardModal(cardId) {
  const board = getCurrentKanbanBoard();
  if (!board) return;
  const card = board.cards.find(c => c.id === cardId);
  if (!card) return;

  kanbanEditCardId = cardId;
  document.getElementById('kanban-card-title-input').value = card.title;
  document.getElementById('kanban-card-desc').value = card.description || '';
  document.getElementById('kanban-card-due').value = card.dueDate ? new Date(card.dueDate).toISOString().slice(0, 10) : '';
  document.getElementById('kanban-card-created').textContent = 'Created: ' + new Date(card.createdAt).toLocaleString();

  renderKanbanLinkedNotes(card);
  $kanbanCardModal.classList.remove('hidden');
}

function renderKanbanLinkedNotes(card) {
  const list = document.getElementById('kanban-linked-list');
  list.innerHTML = '';
  (card.linkedNoteIds || []).forEach(noteId => {
    const note = allNotes.find(n => n.id === noteId);
    const row = document.createElement('div');
    row.className = 'kanban-linked-note';

    const icon = document.createElement('span');
    icon.textContent = '\uD83D\uDCC4';
    icon.style.flexShrink = '0';

    const nameSpan = document.createElement('span');
    nameSpan.textContent = note ? note.title : '(deleted note)';
    nameSpan.addEventListener('click', () => {
      if (note) {
        closeKanbanCardModal();
        closeKanbanView();
        openNote(note.id);
      }
    });

    const removeBtn = document.createElement('button');
    removeBtn.textContent = '\u00d7';
    removeBtn.title = 'Remove link';
    removeBtn.addEventListener('click', async () => {
      card.linkedNoteIds = card.linkedNoteIds.filter(id => id !== noteId);
      await saveCurrentKanbanBoard();
      renderKanbanLinkedNotes(card);
    });

    row.append(icon, nameSpan, removeBtn);
    list.appendChild(row);
  });
}

function closeKanbanCardModal() {
  $kanbanCardModal.classList.add('hidden');
  kanbanEditCardId = null;
}

// Modal close button
document.getElementById('kanban-modal-close').addEventListener('click', closeKanbanCardModal);
$kanbanCardModal.addEventListener('click', e => {
  if (e.target === $kanbanCardModal) closeKanbanCardModal();
});

// Save button
document.getElementById('kanban-card-save').addEventListener('click', async () => {
  const board = getCurrentKanbanBoard();
  if (!board || !kanbanEditCardId) return;
  const card = board.cards.find(c => c.id === kanbanEditCardId);
  if (!card) return;

  card.title = document.getElementById('kanban-card-title-input').value.trim() || 'Untitled';
  card.description = document.getElementById('kanban-card-desc').value;
  const dueVal = document.getElementById('kanban-card-due').value;
  card.dueDate = dueVal ? new Date(dueVal + 'T00:00:00').getTime() : null;

  await saveCurrentKanbanBoard();
  closeKanbanCardModal();
  renderKanbanBoard();
});

// Delete button
document.getElementById('kanban-card-delete').addEventListener('click', async () => {
  const board = getCurrentKanbanBoard();
  if (!board || !kanbanEditCardId) return;
  if (!confirm('Delete this card?')) return;
  board.cards = board.cards.filter(c => c.id !== kanbanEditCardId);
  await saveCurrentKanbanBoard();
  closeKanbanCardModal();
  renderKanbanBoard();
});

// Accept note drops on linked notes list in modal
const $kanbanLinkedList = document.getElementById('kanban-linked-list');
$kanbanLinkedList.addEventListener('dragover', e => {
  if (dragItem && dragItem.type === 'note') {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'link';
    $kanbanLinkedList.classList.add('drag-over');
  }
});
$kanbanLinkedList.addEventListener('dragleave', () => {
  $kanbanLinkedList.classList.remove('drag-over');
});
$kanbanLinkedList.addEventListener('drop', async e => {
  $kanbanLinkedList.classList.remove('drag-over');
  if (dragItem && dragItem.type === 'note' && kanbanEditCardId) {
    e.preventDefault();
    const board = getCurrentKanbanBoard();
    if (!board) return;
    const card = board.cards.find(c => c.id === kanbanEditCardId);
    if (card && !card.linkedNoteIds.includes(dragItem.id)) {
      card.linkedNoteIds.push(dragItem.id);
      await saveCurrentKanbanBoard();
      renderKanbanLinkedNotes(card);
    }
  }
});

// ===== Profile System UI =====

async function switchProfile(profileId) {
  // Close current DB
  if (db) db.close();

  setActiveProfileId(profileId);
  db = null;
  await openDB();

  // Reset all state
  allNotes = await dbGetAll('notes');
  allFolders = await dbGetAll('folders');
  allSlabBoards = await dbGetAll('slabs') || [];
  allKanbanBoards = await dbGetAll('kanban') || [];
  currentNote = null;
  currentSlabId = null;
  currentKanbanId = null;

  // Hide special views
  $kanbanView.classList.add('hidden');
  $neuralSlab.classList.add('hidden');
  $vennView.classList.add('hidden');
  $editorArea.classList.remove('hidden');

  // Restore theme/sidebar for this profile
  const theme = await dbGet('settings', 'theme');
  if (theme) document.documentElement.setAttribute('data-theme', theme.value);

  const sidebarWidth = await dbGet('settings', 'sidebarWidth');
  if (sidebarWidth) $sidebar.style.width = sidebarWidth.value + 'px';

  renderTree();
  setEditorState(false);
  renderProfileSwitcher();
  setSaveStatus('saved');
}

function renderProfileSwitcher() {
  const container = document.getElementById('profile-switcher');
  if (!container) return;
  const profiles = getProfiles();
  const activeId = getActiveProfileId();
  const active = profiles.find(p => p.id === activeId) || profiles[0];

  container.innerHTML = '';

  const btn = document.createElement('button');
  btn.id = 'profile-btn';
  btn.title = 'Switch profile';
  btn.textContent = '\uD83D\uDC64 ' + (active ? active.name : 'Default');
  container.appendChild(btn);

  const dropdown = document.createElement('div');
  dropdown.id = 'profile-dropdown';
  dropdown.className = 'hidden';

  profiles.forEach(p => {
    const item = document.createElement('button');
    item.className = 'profile-item' + (p.id === activeId ? ' active' : '');
    item.textContent = p.name;
    item.addEventListener('click', async e => {
      e.stopPropagation();
      dropdown.classList.add('hidden');
      if (p.id !== activeId) await switchProfile(p.id);
    });
    dropdown.appendChild(item);
  });

  const divider = document.createElement('div');
  divider.className = 'profile-divider';
  dropdown.appendChild(divider);

  const newBtn = document.createElement('button');
  newBtn.className = 'profile-item profile-action';
  newBtn.textContent = '+ New Profile';
  newBtn.addEventListener('click', async e => {
    e.stopPropagation();
    dropdown.classList.add('hidden');
    const name = prompt('Profile name:');
    if (!name || !name.trim()) return;
    const profiles = getProfiles();
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    profiles.push({ id, name: name.trim() });
    saveProfiles(profiles);
    await switchProfile(id);
  });
  dropdown.appendChild(newBtn);

  const renameBtn = document.createElement('button');
  renameBtn.className = 'profile-item profile-action';
  renameBtn.textContent = '\u270E Rename Profile';
  renameBtn.addEventListener('click', e => {
    e.stopPropagation();
    dropdown.classList.add('hidden');
    const profiles = getProfiles();
    const current = profiles.find(p => p.id === activeId);
    if (!current) return;
    const newName = prompt('Rename profile:', current.name);
    if (!newName || !newName.trim()) return;
    current.name = newName.trim();
    saveProfiles(profiles);
    renderProfileSwitcher();
  });
  dropdown.appendChild(renameBtn);

  const delBtn = document.createElement('button');
  delBtn.className = 'profile-item profile-action profile-danger';
  delBtn.textContent = '\uD83D\uDDD1 Delete Profile';
  delBtn.addEventListener('click', async e => {
    e.stopPropagation();
    dropdown.classList.add('hidden');
    let profiles = getProfiles();
    if (profiles.length <= 1) {
      alert('Cannot delete the only profile.');
      return;
    }
    const current = profiles.find(p => p.id === activeId);
    if (!confirm(`Delete profile "${current.name}" and all its data?`)) return;

    // Delete the profile's database
    if (db) db.close();
    db = null;
    const dbName = getDBName(activeId);
    await new Promise((resolve, reject) => {
      const req = indexedDB.deleteDatabase(dbName);
      req.onsuccess = () => resolve();
      req.onerror = e => reject(e.target.error);
      req.onblocked = () => resolve();
    });

    profiles = profiles.filter(p => p.id !== activeId);
    saveProfiles(profiles);
    await switchProfile(profiles[0].id);
  });
  dropdown.appendChild(delBtn);

  container.appendChild(dropdown);

  btn.addEventListener('click', e => {
    e.stopPropagation();
    dropdown.classList.toggle('hidden');
  });

  // Close dropdown on outside click
  document.addEventListener('click', () => {
    dropdown.classList.add('hidden');
  });
}

// ===== Auto-Backup (every 10 minutes to De'Scribe Backups folder) =====
let autoBackupDirHandle = null;
let autoBackupInterval = null;
const AUTO_BACKUP_MS = 10 * 60 * 1000; // 10 minutes
const AUTO_BACKUP_MAX = 20; // keep last 20 backups

async function getBackupData() {
  const profiles = getProfiles();
  const allProfileData = {};
  const STORES = ['notes', 'folders', 'slabs', 'kanban', 'images', 'settings'];
  for (const profile of profiles) {
    const pdb = await openDBForProfile(profile.id);
    const profileData = {};
    for (const store of STORES) {
      profileData[store] = await new Promise((resolve, reject) => {
        const tx = pdb.transaction(store, 'readonly');
        const req = tx.objectStore(store).getAll();
        req.onsuccess = () => resolve(req.result);
        req.onerror = e => reject(e.target.error);
      });
    }
    allProfileData[profile.id] = profileData;
    if (pdb !== db) pdb.close();
  }
  return {
    version: 2,
    exportedAt: new Date().toISOString(),
    app: 'de-scribe',
    profiles: profiles,
    activeProfile: getActiveProfileId(),
    profileData: allProfileData
  };
}

async function performAutoBackup() {
  if (!autoBackupDirHandle) return;
  try {
    // Verify we still have permission
    if ((await autoBackupDirHandle.queryPermission({ mode: 'readwrite' })) !== 'granted') {
      stopAutoBackup();
      return;
    }
    const data = await getBackupData();
    const now = new Date();
    const timestamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const fileName = `de-scribe-backup-${timestamp}.json`;
    const fileHandle = await autoBackupDirHandle.getFileHandle(fileName, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(JSON.stringify(data, null, 2));
    await writable.close();

    // Prune old backups — keep only the most recent ones
    const entries = [];
    for await (const [name, handle] of autoBackupDirHandle) {
      if (handle.kind === 'file' && name.startsWith('de-scribe-backup-') && name.endsWith('.json')) {
        entries.push(name);
      }
    }
    entries.sort();
    while (entries.length > AUTO_BACKUP_MAX) {
      const oldest = entries.shift();
      await autoBackupDirHandle.removeEntry(oldest);
    }

    setSaveStatus('saved');
    console.log('[Auto-Backup] Saved:', fileName);
  } catch (err) {
    console.warn('[Auto-Backup] Failed:', err);
  }
}

function startAutoBackup() {
  if (autoBackupInterval) clearInterval(autoBackupInterval);
  autoBackupInterval = setInterval(performAutoBackup, AUTO_BACKUP_MS);
  // Also run one immediately
  performAutoBackup();
  updateAutoBackupBtn();
}

function stopAutoBackup() {
  if (autoBackupInterval) clearInterval(autoBackupInterval);
  autoBackupInterval = null;
  autoBackupDirHandle = null;
  localStorage.removeItem('describeAutoBackup');
  updateAutoBackupBtn();
}

function updateAutoBackupBtn() {
  const btn = document.getElementById('auto-backup-btn');
  if (!btn) return;
  if (autoBackupDirHandle) {
    btn.title = 'Auto-backup ON (every 10 min) — click to disable';
    btn.classList.add('auto-backup-active');
  } else {
    btn.title = 'Enable auto-backup (every 10 min)';
    btn.classList.remove('auto-backup-active');
  }
}

document.getElementById('auto-backup-btn').addEventListener('click', async () => {
  if (autoBackupDirHandle) {
    stopAutoBackup();
    return;
  }
  try {
    const dirHandle = await window.showDirectoryPicker({ mode: 'readwrite', startIn: 'documents' });
    // Try to get or create the "De'Scribe Backups" subfolder
    autoBackupDirHandle = await dirHandle.getDirectoryHandle("De'Scribe Backups", { create: true });
    localStorage.setItem('describeAutoBackup', 'enabled');
    startAutoBackup();
  } catch (err) {
    if (err.name !== 'AbortError') {
      console.warn('[Auto-Backup] Setup failed:', err);
      alert('Could not set up auto-backup: ' + err.message);
    }
  }
});

// ===== Start =====
init();
