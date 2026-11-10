export type Todo = {
  id: number;
  title: string;
  done: boolean;
};

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, options);
  if (!res.ok) {
    throw new Error(`Request failed: ${res.status}`);
  }
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}

export const getTodos = () => request<Todo[]>('/api/todos');

export const addTodo = (title: string) =>
  request<Todo>('/api/todos', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title }),
  });

export const toggleTodo = (id: number) =>
  request<Todo>(`/api/todos/${id}/toggle`, { method: 'PUT' });

export const deleteTodo = (id: number) =>
  request<void>(`/api/todos/${id}`, { method: 'DELETE' });
