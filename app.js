const STORAGE_KEY = "oct7-kanban-board-v1";
const SUPABASE_MODULE = "https://esm.sh/@supabase/supabase-js@2.117.2";

const columns = [
  { id: "do-next", label: "Do next" },
  { id: "verify", label: "Verify" },
  { id: "upcoming", label: "Upcoming" },
  { id: "waiting", label: "Waiting" },
  { id: "done", label: "Done" },
];

let state = loadLocalState();
let draggedTaskId = null;
let supabase = null;
let sharedMode = false;
let taskChannel = null;

const app = document.querySelector("#app");
const authScreen = document.querySelector("#auth-screen");
const authForm = document.querySelector("#auth-form");
const authEmail = document.querySelector("#auth-email");
const authStatus = document.querySelector("#auth-status");
const signOutButton = document.querySelector("#sign-out");
const board = document.querySelector("#board");
const search = document.querySelector("#search");
const dialog = document.querySelector("#task-dialog");
const form = document.querySelector("#task-form");
const taskTitle = document.querySelector("#task-title");
const columnPicker = document.querySelector("#column-picker");

function emptyState() {
  return { version: 1, tasks: [] };
}

function loadLocalState() {
  try {
    return normalizeState(JSON.parse(localStorage.getItem(STORAGE_KEY)));
  } catch {
    return emptyState();
  }
}

function normalizeState(value) {
  if (!value || !Array.isArray(value.tasks)) return emptyState();
  const validColumns = new Set(columns.map((column) => column.id));
  const tasks = value.tasks
    .filter((task) => task && typeof task.title === "string")
    .map((task, index) => ({
      id: typeof task.id === "string" ? task.id : crypto.randomUUID(),
      title: task.title.trim(),
      column: validColumns.has(task.column) ? task.column : columns[0].id,
      order: Number.isFinite(task.order) ? task.order : index,
    }))
    .filter((task) => task.title);
  return { version: 1, tasks };
}

function saveLocalState() {
  if (!sharedMode) localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function showApp() {
  authScreen.hidden = true;
  app.hidden = false;
  signOutButton.hidden = !sharedMode;
}

function showAuth(status = "") {
  app.hidden = true;
  authScreen.hidden = false;
  authStatus.textContent = status;
}

async function initialize() {
  renderColumnPicker();
  renderBoard();
  const config = window.OCT7_CONFIG || {};

  if (!config.supabaseUrl || !config.supabasePublishableKey) {
    showApp();
    return;
  }

  sharedMode = true;
  try {
    const { createClient } = await import(SUPABASE_MODULE);
    supabase = createClient(config.supabaseUrl, config.supabasePublishableKey);
    supabase.auth.onAuthStateChange((_event, session) => {
      window.setTimeout(() => handleSession(session), 0);
    });
    const { data } = await supabase.auth.getSession();
    await handleSession(data.session);
  } catch {
    showAuth("Access unavailable");
  }
}

async function handleSession(session) {
  if (!session) {
    stopRealtime();
    showAuth();
    return;
  }

  const email = session.user.email?.toLocaleLowerCase();
  const { data, error } = await supabase
    .from("allowed_members")
    .select("email")
    .eq("email", email)
    .maybeSingle();

  if (error || !data) {
    await supabase.auth.signOut();
    showAuth("Access unavailable");
    return;
  }

  await loadSharedState();
  startRealtime();
  showApp();
}

async function loadSharedState() {
  const { data, error } = await supabase
    .from("tasks")
    .select("id,title,column_id,position")
    .order("position", { ascending: true });

  if (error) {
    showAuth("Access unavailable");
    return;
  }

  state = {
    version: 1,
    tasks: data.map((task) => ({
      id: task.id,
      title: task.title,
      column: task.column_id,
      order: Number(task.position),
    })),
  };
  renderBoard();
}

function startRealtime() {
  stopRealtime();
  taskChannel = supabase
    .channel("oct7-tasks")
    .on("postgres_changes", { event: "*", schema: "public", table: "tasks" }, loadSharedState)
    .subscribe();
}

function stopRealtime() {
  if (taskChannel && supabase) supabase.removeChannel(taskChannel);
  taskChannel = null;
}

async function createTask(title, column) {
  const task = {
    id: crypto.randomUUID(),
    title,
    column,
    order: nextOrder(column),
  };
  state.tasks.push(task);
  saveLocalState();
  renderBoard();
  if (!sharedMode) return;

  const { error } = await supabase.from("tasks").insert(toDatabaseTask(task));
  if (error) await loadSharedState();
}

async function updateTask(task) {
  saveLocalState();
  renderBoard();
  if (!sharedMode) return;

  const { error } = await supabase
    .from("tasks")
    .update({
      title: task.title,
      column_id: task.column,
      position: task.order,
      updated_at: new Date().toISOString(),
    })
    .eq("id", task.id);
  if (error) await loadSharedState();
}

async function deleteTask(taskId) {
  state.tasks = state.tasks.filter((task) => task.id !== taskId);
  saveLocalState();
  renderBoard();
  if (!sharedMode) return;

  const { error } = await supabase.from("tasks").delete().eq("id", taskId);
  if (error) await loadSharedState();
}

function toDatabaseTask(task) {
  return {
    id: task.id,
    title: task.title,
    column_id: task.column,
    position: task.order,
    updated_at: new Date().toISOString(),
  };
}

function renderBoard() {
  const query = search.value.trim().toLocaleLowerCase();
  board.replaceChildren();

  for (const column of columns) {
    const section = document.createElement("section");
    section.className = "column";
    section.dataset.column = column.id;
    const header = document.createElement("header");
    header.className = "column-header";
    const heading = document.createElement("h2");
    heading.textContent = column.label;
    const count = document.createElement("span");
    count.className = "count";
    const tasks = state.tasks
      .filter((task) => task.column === column.id)
      .sort((a, b) => a.order - b.order);
    count.textContent = String(tasks.length);
    header.append(heading, count);

    const list = document.createElement("div");
    list.className = "task-list";
    list.dataset.column = column.id;
    list.addEventListener("dragover", handleDragOver);
    list.addEventListener("dragleave", () => list.classList.remove("is-over"));
    list.addEventListener("drop", handleDrop);
    for (const task of tasks) list.append(createTaskCard(task, query));

    section.append(header, list);
    board.append(section);
  }
}

function createTaskCard(task, query) {
  const card = document.createElement("article");
  card.className = "task-card";
  card.dataset.taskId = task.id;
  card.draggable = true;
  card.tabIndex = 0;
  card.textContent = task.title;
  card.classList.toggle(
    "is-hidden",
    Boolean(query) && !task.title.toLocaleLowerCase().includes(query),
  );

  card.addEventListener("dragstart", () => {
    draggedTaskId = task.id;
    card.classList.add("is-dragging");
  });
  card.addEventListener("dragend", () => {
    draggedTaskId = null;
    card.classList.remove("is-dragging");
    document.querySelectorAll(".task-list").forEach((list) => list.classList.remove("is-over"));
  });
  card.addEventListener("dblclick", () => beginEditing(card, task));
  card.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !card.isContentEditable) {
      event.preventDefault();
      beginEditing(card, task);
    }
    if ((event.key === "Delete" || event.key === "Backspace") && !card.isContentEditable) {
      deleteTask(task.id);
    }
  });
  return card;
}

function beginEditing(card, task) {
  card.draggable = false;
  card.contentEditable = "true";
  card.focus();
  const range = document.createRange();
  range.selectNodeContents(card);
  range.collapse(false);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);

  const handleEditKeydown = (event) => {
    if (event.key === "Escape") {
      card.textContent = task.title;
      card.blur();
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      card.blur();
    }
  };
  const finish = () => {
    const title = card.textContent.trim();
    if (title) task.title = title;
    card.contentEditable = "false";
    card.draggable = true;
    card.removeEventListener("keydown", handleEditKeydown);
    updateTask(task);
  };
  card.addEventListener("blur", finish, { once: true });
  card.addEventListener("keydown", handleEditKeydown);
}

function handleDragOver(event) {
  event.preventDefault();
  event.currentTarget.classList.add("is-over");
}

function handleDrop(event) {
  event.preventDefault();
  const destination = event.currentTarget.dataset.column;
  event.currentTarget.classList.remove("is-over");
  const task = state.tasks.find((item) => item.id === draggedTaskId);
  if (!task || !columns.some((column) => column.id === destination)) return;
  task.column = destination;
  task.order = nextOrder(destination);
  updateTask(task);
}

function nextOrder(columnId) {
  const orders = state.tasks
    .filter((task) => task.column === columnId)
    .map((task) => task.order);
  return orders.length ? Math.max(...orders) + 1 : 0;
}

function renderColumnPicker() {
  columnPicker.replaceChildren();
  columns.forEach((column, index) => {
    const label = document.createElement("label");
    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = "column";
    radio.value = column.id;
    radio.checked = index === 0;
    label.append(radio, document.createTextNode(column.label));
    columnPicker.append(label);
  });
}

authForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  authStatus.textContent = "";
  const { error } = await supabase.auth.signInWithOtp({
    email: authEmail.value.trim().toLocaleLowerCase(),
    options: { emailRedirectTo: window.location.origin + window.location.pathname },
  });
  authStatus.textContent = error ? "Access unavailable" : "Check your email";
});

signOutButton.addEventListener("click", async () => {
  stopRealtime();
  await supabase.auth.signOut();
  showAuth();
});

document.querySelector("#add-task").addEventListener("click", () => {
  form.reset();
  renderColumnPicker();
  dialog.showModal();
});

form.addEventListener("submit", () => {
  const title = taskTitle.value.trim();
  const column = new FormData(form).get("column") || columns[0].id;
  if (title) createTask(title, column);
});

search.addEventListener("input", renderBoard);

document.querySelector("#export-backup").addEventListener("click", () => {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `oct7-kanban-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
  URL.revokeObjectURL(link.href);
});

document.querySelector("#import-tasks").addEventListener("change", async (event) => {
  const [file] = event.target.files;
  if (!file) return;
  try {
    const imported = normalizeState(JSON.parse(await file.text()));
    for (const task of imported.tasks) await createTask(task.title, task.column);
  } catch {
    authStatus.textContent = "Access unavailable";
  } finally {
    event.target.value = "";
  }
});

initialize();
