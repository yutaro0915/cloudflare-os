const definitions = [
  {id: "todo", title: "To do"},
  {id: "doing", title: "Doing"},
  {id: "done", title: "Done"},
];

function stateOf(value) {
  return value ?? {
    schemaVersion: 1,
    nextId: 1,
    columns: definitions.map(column => ({...column, tasks: []})),
  };
}

function documentOf(state) {
  return {
    schemaVersion: 1,
    title: "Test Kanban",
    form: {actionId: "task.create", label: "Add task", placeholder: "Task", maxLength: 200},
    columns: state.columns.map(column => ({
      columnId: column.id,
      title: column.title,
      items: column.tasks.map(task => ({
        itemId: task.id,
        title: task.title,
        actions: [
          ...state.columns.filter(other => other.id !== column.id).map(other => ({
            actionId: `task.move:${task.id}:${other.id}`,
            label: `Move to ${other.title}`,
            tone: "neutral",
          })),
          {actionId: `task.delete:${task.id}`, label: "Delete", tone: "danger"},
        ],
      })),
    })),
  };
}

function reduce({state: value, action}) {
  const state = structuredClone(stateOf(value));
  if (action.actionId === "task.create") {
    state.columns[0].tasks.push({id: `task-${state.nextId++}`, title: action.input.trim()});
  } else if (action.actionId.startsWith("task.move:")) {
    const [, taskId, destinationId] = action.actionId.split(":");
    const source = state.columns.find(column => column.tasks.some(task => task.id === taskId));
    const destination = state.columns.find(column => column.id === destinationId);
    const [task] = source.tasks.splice(source.tasks.findIndex(candidate => candidate.id === taskId), 1);
    destination.tasks.push(task);
  } else if (action.actionId.startsWith("task.delete:")) {
    const taskId = action.actionId.slice("task.delete:".length);
    const source = state.columns.find(column => column.tasks.some(task => task.id === taskId));
    source.tasks.splice(source.tasks.findIndex(candidate => candidate.id === taskId), 1);
  } else throw new TypeError("unknown action");
  return {state, document: documentOf(state)};
}

export default {render: ({state}) => documentOf(stateOf(state)), reduce};
