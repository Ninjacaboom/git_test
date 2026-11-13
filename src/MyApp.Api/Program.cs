using MyApp.Api.Models;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddOpenApi();

var app = builder.Build();

if (app.Environment.IsDevelopment())
{
    app.MapOpenApi(); // OpenAPI spec at /openapi/v1.json
}

// Game reference data (materials, resources, recipes), loaded once from the Data folder.
var bank = DataBank.Load(Path.Combine(app.Environment.ContentRootPath, "Data"));

app.MapGet("/api/materials", () => bank.Materials);

app.MapGet("/api/resources", () => bank.Resources);

app.MapGet("/api/recipe-types", () => bank.RecipeTypes());

// Example: /api/recipes?search=aves&type=Char_Armor_Torso&weight=heavy,medium&includeSkins=false
app.MapGet("/api/recipes", (string? search, string? type, bool? includeSkins, string? weight, string? ammo) =>
    bank.Search(search, type, includeSkins ?? true, weight, ammo));

app.MapGet("/api/recipes/{id}", (string id) =>
    bank.GetRecipe(id) is { } recipe ? Results.Ok(recipe) : Results.NotFound());

// Body: { "qualities": { "SHELL": 800, "COOLANT": 650 } }  (slot name -> quality 0-1000).
// Slots left out count as 500 (baseline). Returns the combined effect on each stat.
app.MapPost("/api/recipes/{id}/stats", (string id, StatsRequest request) =>
{
    if (bank.GetRecipe(id) is not { } recipe) return Results.NotFound();

    var qualities = request.Qualities ?? new Dictionary<string, int>();
    var unknown = qualities.Keys.Where(k => recipe.Slots.All(s => s.Name != k)).ToList();
    if (unknown.Count > 0)
    {
        return Results.BadRequest(new { error = $"Unknown slot(s): {string.Join(", ", unknown)}" });
    }

    return Results.Ok(QualityMath.RecipeEffects(recipe, qualities));
});

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

record StatsRequest(Dictionary<string, int>? Qualities);
record Todo(int Id, string Title, bool Done);
record NewTodo(string Title);
