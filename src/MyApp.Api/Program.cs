using System.Text.Json;
using MyApp.Api.Models;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddOpenApi();

var app = builder.Build();

if (app.Environment.IsDevelopment())
{
    app.MapOpenApi(); // OpenAPI spec at /openapi/v1.json
}

// Material catalog (ores + minerals and the fixed qualities they exist at).
// Loaded from Data/materials.json. This moves into the database later.
var materialsPath = Path.Combine(app.Environment.ContentRootPath, "Data", "materials.json");
var materials = JsonSerializer.Deserialize<List<Material>>(
    File.ReadAllText(materialsPath),
    new JsonSerializerOptions(JsonSerializerDefaults.Web)) ?? [];

app.MapGet("/api/materials", () => materials);

// In-memory list for now. Swap for a database (EF Core) later.
var todos = new List<Todo>
{
    new(1, "Learn C# and .NET 10", false),
    new(2, "Connect React to the API", false),
};
var nextId = 3;

app.MapGet("/api/hello", () => new { message = "Hello from .NET 10" });

app.MapGet("/api/todos", () => todos);

app.MapPost("/api/todos", (NewTodo input) =>
{
    if (string.IsNullOrWhiteSpace(input.Title))
    {
        return Results.BadRequest(new { error = "Title is required." });
    }

    var todo = new Todo(nextId++, input.Title.Trim(), false);
    todos.Add(todo);
    return Results.Created($"/api/todos/{todo.Id}", todo);
});

app.MapPut("/api/todos/{id:int}/toggle", (int id) =>
{
    var index = todos.FindIndex(t => t.Id == id);
    if (index < 0) return Results.NotFound();

    todos[index] = todos[index] with { Done = !todos[index].Done };
    return Results.Ok(todos[index]);
});

app.MapDelete("/api/todos/{id:int}", (int id) =>
    todos.RemoveAll(t => t.Id == id) > 0 ? Results.NoContent() : Results.NotFound());

app.Run();

record Todo(int Id, string Title, bool Done);
record NewTodo(string Title);
