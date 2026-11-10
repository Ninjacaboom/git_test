import { useEffect, useState, type FormEvent } from 'react';
import { addTodo, deleteTodo, getTodos, toggleTodo, type Todo } from './api';

export default function App() {
  const [todos, setTodos] = useState<Todo[]>([]);
  const [title, setTitle] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function load() {
    try {
      setTodos(await getTodos());
      setError(null);
    } catch {
      setError('Could not reach the API. Is the backend running?');
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function handleAdd(e: FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    await addTodo(title);
    setTitle('');
    load();
  }

  return (
    <main>
      <h1>My To-Dos</h1>

      {error && <p className="error">{error}</p>}

      <form onSubmit={handleAdd}>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="What needs doing?"
        />
        <button type="submit">Add</button>
      </form>

      <ul>
        {todos.map((t) => (
          <li key={t.id}>
            <label className={t.done ? 'done' : ''}>
              <input
                type="checkbox"
                checked={t.done}
                onChange={async () => {
                  await toggleTodo(t.id);
                  load();
                }}
              />
              {t.title}
            </label>
            <button
              onClick={async () => {
                await deleteTodo(t.id);
                load();
              }}
            >
              Delete
            </button>
          </li>
        ))}
      </ul>
    </main>
  );
}
