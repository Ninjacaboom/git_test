# MyApp

A .NET 10 (C#) web API with a React + TypeScript front end.

```
MyApp.slnx
src/MyApp.Api/   ASP.NET Core minimal API (http://localhost:5080)
web/             React + Vite front end   (http://localhost:5173)
```

## Prerequisites

- .NET 10 SDK  (`dotnet --version` should print 10.0.x)
- Node.js LTS  (`node --version`)

## Run it (two terminals)

**Terminal 1 - backend**

```
cd src/MyApp.Api
dotnet run
```

Check it works: open http://localhost:5080/api/hello

**Terminal 2 - front end**

```
cd web
npm install
npm run dev
```

Open http://localhost:5173. The Vite dev server forwards `/api` calls to the backend.

## API

| Method | URL                        | What it does       |
| ------ | -------------------------- | ------------------ |
| GET    | /api/hello                 | Test message       |
| GET    | /api/materials             | Ores and minerals with their fixed quality tiers |
| GET    | /api/todos                 | List to-dos        |
| POST   | /api/todos                 | Add `{ "title" }`  |
| PUT    | /api/todos/{id}/toggle     | Flip done / undone |
| DELETE | /api/todos/{id}            | Remove a to-do     |

Data is held in memory and resets whenever the backend restarts.
