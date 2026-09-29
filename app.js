const STORAGE_KEY = "oct7-kanban-board-v1";
const SUPABASE_MODULE = "https://esm.sh/@supabase/supabase-js@2.117.2";

const columns = [
  { id: "do-next", label: "Do next" },
  { id: "verify", label: "Verify" },
  { id: "upcoming", label: "Upcoming" },
  { id: "waiting", label: "Waiting" },
  { id: "done", label: "Done" },
];

const members = [
  { email: "oct7sales@oct7sales.com", color: "#a45e49" },
  { email: "oct7sales@gmail.com", color: "#537b87" },
  { email: "jlong@oct7sales.com", color: "#71834f" },
];
const memberByEmail = new Map(members.map((member) => [member.email, member]));
const urgencyLabels = ["Low", "Medium", "High", "Critical"];
const urgencyColors = ["#98a487", "#c3a065", "#bb7049", "#9e2e25"];
const urgencyAgingMs = 14 * 24 * 60 * 60 * 1000;

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
const taskAssignee = document.querySelector("#task-assignee");
const taskUrgency = document.querySelector("#task-urgency");

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
  const now = new Date().toISOString();
  const tasks = value.tasks
    .filter((task) => task && typeof task.title === "string")
    .map((task, index) => ({
      id: typeof task.id === "string" ? task.id : crypto.randomUUID(),
      title: task.title.trim(),
      column: validColumns.has(task.column) ? task.column : columns[0].id,
      order: Number.isFinite(task.order) ? task.order : index,
      assignee: memberByEmail.has(task.assignee) ? task.assignee : null,
      urgency: Number.isInteger(task.urgency) && task.urgency >= 0 && task.urgency <= 3 ? task.urgency : 0,
      urgencySetAt: validDate(task.urgencySetAt) || now,
      completedAt: validColumns.has(task.column) && task.column === "done"
        ? validDate(task.completedAt) || now
        : null,
    }))
    .filter((task) => task.title);
  return { version: 1, tasks };
}

function validDate(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value))
    ? new Date(value).toISOString()
    : null;
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
  renderAssigneeOptions(taskAssignee);
  renderUrgencyOptions(taskUrgency);
  renderBoard();
  window.setInterval(updateUrgencyAppearance, 60 * 1000);
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
    .select("id,title,column_id,position,assignee_email,urgency_base,urgency_set_at,completed_at")
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
      assignee: task.assignee_email,
      urgency: task.urgency_base,
      urgencySetAt: task.urgency_set_at,
      completedAt: task.completed_at,
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

async function createTask(title, column, assignee = null, urgency = 0, urgencySetAt = null, completedAt = null) {
  const now = new Date().toISOString();
  const task = {
    id: crypto.randomUUID(),
    title,
    column,
    order: nextOrder(column),
    assignee: memberByEmail.has(assignee) ? assignee : null,
    urgency: Number.isInteger(urgency) && urgency >= 0 && urgency <= 3 ? urgency : 0,
    urgencySetAt: validDate(urgencySetAt) || now,
    completedAt: column === "done" ? validDate(completedAt) || now : null,
  };
  state.tasks.push(task);
  saveLocalState();
  renderBoard();
  if (!sharedMode) return;

  const { error } = await supabase.from("tasks").insert(toDatabaseTask(task));
  if (error) await loadSharedState();
}

async function updateTask(task, rerender = true) {
  saveLocalState();
  if (rerender) renderBoard();
  if (!sharedMode) return;

  const { error } = await supabase
    .from("tasks")
    .update({
      title: task.title,
      column_id: task.column,
      position: task.order,
      assignee_email: task.assignee,
      urgency_base: task.urgency,
      urgency_set_at: task.urgencySetAt,
      completed_at: task.completedAt,
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
    assignee_email: task.assignee,
    urgency_base: task.urgency,
    urgency_set_at: task.urgencySetAt,
    completed_at: task.completedAt,
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
  card.style.setProperty("--assignee-color", memberByEmail.get(task.assignee)?.color || "#aaa18f");
  const title = document.createElement("span");
  title.className = "task-card-title";
  title.textContent = task.title;
  const assignee = document.createElement("select");
  assignee.className = "card-assignee";
  assignee.setAttribute("aria-label", "Assigned to");
  renderAssigneeOptions(assignee, task.assignee);
  assignee.addEventListener("pointerdown", () => { card.draggable = false; });
  assignee.addEventListener("blur", () => { card.draggable = true; });
  assignee.addEventListener("change", () => {
    task.assignee = assignee.value || null;
    card.style.setProperty("--assignee-color", memberByEmail.get(task.assignee)?.color || "#aaa18f");
    updateTask(task, false);
  });
  const urgency = document.createElement("select");
  urgency.className = "card-urgency";
  urgency.setAttribute("aria-label", "Urgency");
  renderUrgencyOptions(urgency, task.urgency);
  urgency.addEventListener("pointerdown", () => { card.draggable = false; });
  urgency.addEventListener("blur", () => { card.draggable = true; });
  urgency.addEventListener("change", () => {
    task.urgency = Number(urgency.value);
    task.urgencySetAt = new Date().toISOString();
    setUrgencyAppearance(card, task);
    updateTask(task, false);
  });
  card.append(title, assignee, urgency);
  setUrgencyAppearance(card, task);
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
  card.addEventListener("dblclick", (event) => {
    if (event.target !== assignee && event.target !== urgency) beginEditing(card, title, task);
  });
  card.addEventListener("keydown", (event) => {
    if (event.target !== card) return;
    if (event.key === "Enter") {
      event.preventDefault();
      beginEditing(card, title, task);
    }
    if (event.key === "Delete" || event.key === "Backspace") {
      deleteTask(task.id);
    }
  });
  return card;
}

function beginEditing(card, titleElement, task) {
  card.draggable = false;
  titleElement.contentEditable = "true";
  titleElement.focus();
  const range = document.createRange();
  range.selectNodeContents(titleElement);
  range.collapse(false);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);

  const handleEditKeydown = (event) => {
    if (event.key === "Escape") {
      titleElement.textContent = task.title;
      titleElement.blur();
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      titleElement.blur();
    }
  };
  const finish = () => {
    const previousTitle = task.title;
    const title = titleElement.textContent.trim();
    if (title) task.title = title;
    else titleElement.textContent = task.title;
    titleElement.contentEditable = "false";
    card.draggable = true;
    titleElement.removeEventListener("keydown", handleEditKeydown);
    if (title && title !== previousTitle) updateTask(task);
  };
  titleElement.addEventListener("blur", finish, { once: true });
  titleElement.addEventListener("keydown", handleEditKeydown);
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
  if (task.column !== destination) {
    if (destination === "done") task.completedAt = new Date().toISOString();
    else if (task.column === "done") task.completedAt = null;
  }
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

function renderAssigneeOptions(select, selected = null) {
  select.replaceChildren();
  const unassigned = document.createElement("option");
  unassigned.value = "";
  unassigned.textContent = "Unassigned";
  select.append(unassigned);
  for (const member of members) {
    const option = document.createElement("option");
    option.value = member.email;
    option.textContent = member.email;
    select.append(option);
  }
  select.value = selected || "";
}

function renderUrgencyOptions(select, selected = 0) {
  select.replaceChildren();
  urgencyLabels.forEach((label, level) => {
    const option = document.createElement("option");
    option.value = String(level);
    option.textContent = label;
    select.append(option);
  });
  select.value = String(selected);
}

function effectiveUrgency(task) {
  const start = Date.parse(task.urgencySetAt);
  const end = task.column === "done" ? Date.parse(task.completedAt || task.urgencySetAt) : Date.now();
  const elapsed = Math.max(0, end - start);
  const progress = Math.min(1, elapsed / urgencyAgingMs);
  return task.urgency + (3 - task.urgency) * progress;
}

function urgencyColor(value) {
  const lower = Math.min(3, Math.floor(value));
  const upper = Math.min(3, lower + 1);
  const mix = value - lower;
  const start = urgencyColors[lower].slice(1).match(/../g).map((part) => parseInt(part, 16));
  const end = urgencyColors[upper].slice(1).match(/../g).map((part) => parseInt(part, 16));
  const channels = start.map((part, index) => Math.round(part + (end[index] - part) * mix));
  return "rgb(" + channels.join(", ") + ")";
}

function setUrgencyAppearance(card, task) {
  const value = effectiveUrgency(task);
  card.style.setProperty("--urgency-color", urgencyColor(value));
  card.style.setProperty("--urgency-width", Math.round((value / 3) * 100) + "%");
  const select = card.querySelector(".card-urgency");
  if (select && document.activeElement !== select) select.value = String(Math.floor(value));
}

function updateUrgencyAppearance() {
  document.querySelectorAll(".task-card").forEach((card) => {
    const task = state.tasks.find((item) => item.id === card.dataset.taskId);
    if (task) setUrgencyAppearance(card, task);
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
  taskAssignee.value = "";
  taskUrgency.value = "0";
  dialog.showModal();
});

form.addEventListener("submit", () => {
  const title = taskTitle.value.trim();
  const column = new FormData(form).get("column") || columns[0].id;
  const assignee = taskAssignee.value || null;
  const urgency = Number(taskUrgency.value);
  if (title) createTask(title, column, assignee, urgency);
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
    for (const task of imported.tasks) {
      await createTask(task.title, task.column, task.assignee, task.urgency, task.urgencySetAt, task.completedAt);
    }
  } catch {
    authStatus.textContent = "Access unavailable";
  } finally {
    event.target.value = "";
  }
});

initialize();
