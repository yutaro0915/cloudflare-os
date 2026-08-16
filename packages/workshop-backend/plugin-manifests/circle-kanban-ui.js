const columns = [
  {id: "todo", title: "To do"},
  {id: "doing", title: "Doing"},
  {id: "done", title: "Done"},
];

function initialState() {
  return {
    schemaVersion: 1,
    columns: columns.map(column => ({...column, tasks: []})),
  };
}

function currentState(value) {
  if (value === null) return initialState();
  if (value?.schemaVersion !== 1 || !Array.isArray(value.columns)) {
    throw new TypeError("Invalid Kanban state.");
  }
  return structuredClone(value);
}

function render(stateValue) {
  const state = currentState(stateValue);
  return {
    schemaVersion: 1,
    title: "Personal Kanban",
    form: {
      actionId: "task.create",
      label: "Add task",
      placeholder: "What needs to be done?",
      maxLength: 200,
    },
    columns: state.columns.map(column => ({
      columnId: column.id,
      title: column.title,
      items: column.tasks.map(task => ({
        itemId: task.id,
        title: task.title,
        actions: [
          ...state.columns
            .filter(destination => destination.id !== column.id)
            .map(destination => ({
              actionId: `task.move:${task.id}:${destination.id}`,
              label: `Move to ${destination.title}`,
              tone: "neutral",
            })),
          {actionId: `task.delete:${task.id}`, label: "Delete", tone: "danger"},
        ],
      })),
    })),
  };
}

function reduce({state: stateValue, action}) {
  const state = currentState(stateValue);
  if (action.actionId === "task.create") {
    const title = action.input?.trim();
    if (!title || title.length > 200) throw new TypeError("Invalid task title.");
    state.columns[0].tasks.push({id: crypto.randomUUID(), title});
  } else if (action.actionId.startsWith("task.move:")) {
    const [, taskId, destinationId] = action.actionId.split(":");
    const source = state.columns.find(column => column.tasks.some(task => task.id === taskId));
    const destination = state.columns.find(column => column.id === destinationId);
    if (!source || !destination) throw new TypeError("Unknown task move.");
    const index = source.tasks.findIndex(task => task.id === taskId);
    const [task] = source.tasks.splice(index, 1);
    destination.tasks.push(task);
  } else if (action.actionId.startsWith("task.delete:")) {
    const taskId = action.actionId.slice("task.delete:".length);
    const source = state.columns.find(column => column.tasks.some(task => task.id === taskId));
    if (!source) throw new TypeError("Unknown task deletion.");
    source.tasks.splice(source.tasks.findIndex(task => task.id === taskId), 1);
  } else {
    throw new TypeError("Unknown Kanban action.");
  }
  return {state, document: render(state)};
}

export default {render: ({state}) => render(state), reduce};
