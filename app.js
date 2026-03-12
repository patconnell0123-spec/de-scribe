/* ============================================================
   De'Scribe — Local-first Markdown Notes App
   ============================================================ */

// ===== IndexedDB Wrapper =====
const DB_NAME = 'describeDB';
const DB_VERSION = 2;
let db;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
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
    };
    req.onsuccess = e => { db = e.target.result; resolve(db); };
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

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// ===== State =====
let allNotes = [];
let allFolders = [];
let currentNote = null;
let saveTimeout = null;

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
  await openDB();
  allNotes = await dbGetAll('notes');
  allFolders = await dbGetAll('folders');

  const theme = await dbGet('settings', 'theme');
  if (theme) document.documentElement.setAttribute('data-theme', theme.value);

  const sidebarWidth = await dbGet('settings', 'sidebarWidth');
  if (sidebarWidth) $sidebar.style.width = sidebarWidth.value + 'px';

  renderTree();
  setEditorState(false);

  const lastNote = await dbGet('settings', 'lastNote');
  if (lastNote) {
    const note = allNotes.find(n => n.id === lastNote.value);
    if (note) openNote(note.id);
  }

  const lastView = await dbGet('settings', 'viewMode');
  if (lastView) setViewMode(lastView.value);

  await loadSlabs();

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

  function buildLevel(parentId) {
    const ul = document.createElement('ul');
    const childFolders = folders.filter(f => (f.parentId || null) === parentId);
    const childNotes = notes.filter(n => (n.folderId || null) === parentId && !n.deleted);
    const childSlabs = slabs.filter(b => (b.folderId || null) === parentId);

    childFolders.forEach(folder => {
      const li = document.createElement('li');

      const div = document.createElement('div');
      div.className = 'tree-item';
      div.dataset.type = 'folder';
      div.dataset.id = folder.id;
      div.draggable = true;

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

    return ul;
  }

  $tree.innerHTML = '';
  $tree.appendChild(buildLevel(null));
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
    } else if (dragItem.type === 'folder') {
      const folder = allFolders.find(f => f.id === dragItem.id);
      if (folder) { folder.parentId = null; await dbPut('folders', folder); }
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

  if (action === 'rename') {
    startInlineRename(ctxTarget.type, ctxTarget.id);
  }

  if (action === 'delete') {
    let name;
    if (ctxTarget.type === 'folder') name = allFolders.find(f => f.id === ctxTarget.id)?.name;
    else if (ctxTarget.type === 'slab') name = allSlabBoards.find(b => b.id === ctxTarget.id)?.name;
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
  currentNote = note;
  $editor.value = note.content;
  $noteTitleInput.value = note.title;
  $noteTitleBar.classList.remove('hidden');
  updatePreview();
  updateWordCount();
  updateEditorBranchMarkers();
  updateEditorHighlight();
  updateMinimapContent();
  setEditorState(true);
  renderTree();
  renderBranchPanel();
  dbPut('settings', { key: 'lastNote', value: id });
}

$noteTitleInput.addEventListener('input', async () => {
  if (!currentNote) return;
  const newTitle = $noteTitleInput.value.trim() || 'Untitled';
  currentNote.title = newTitle;
  currentNote.updatedAt = Date.now();
  clearTimeout(saveTimeout);
  saveTimeout = setTimeout(async () => {
    await dbPut('notes', currentNote);
    $statusMsg.textContent = 'Saved';
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
  $statusMsg.textContent = 'Typing...';

  clearTimeout(saveTimeout);
  saveTimeout = setTimeout(async () => {
    await dbPut('notes', currentNote);
    $statusMsg.textContent = 'Saved';
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
  const text = $editor.value.trim();
  const words = text ? text.split(/\s+/).length : 0;
  $wordCount.textContent = `${words} word${words !== 1 ? 's' : ''}`;
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
  $editorContainer.className = mode;
  document.querySelectorAll('.view-btn').forEach(b => b.classList.remove('active'));
  document.getElementById(mode)?.classList.add('active');
  dbPut('settings', { key: 'viewMode', value: mode });
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
}

$searchInput.addEventListener('input', () => {
  const query = $searchInput.value.trim().toLowerCase();
  if (!query) { closeSearchDropdown(); return; }

  const results = allNotes.filter(n =>
    !n.deleted &&
    (n.title.toLowerCase().includes(query) ||
    n.content.toLowerCase().includes(query))
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

// ===== Theme Toggle =====
document.getElementById('theme-btn').addEventListener('click', async () => {
  const current = document.documentElement.getAttribute('data-theme');
  const next = current === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  await dbPut('settings', { key: 'theme', value: next });
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
  if (window.innerWidth <= 768 && e.target.closest('.tree-item[data-type="note"]')) {
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

  // Show slab, hide editor
  $editorArea.classList.add('hidden');
  $neuralSlab.classList.remove('hidden');

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

// ===== Start =====
init();
