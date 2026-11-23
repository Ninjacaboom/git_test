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

// ---- Stand-in members and squadrons (the NOVA portal will supply these later) ----
app.MapGet("/api/members", () => Org.Members);
app.MapGet("/api/squadrons", () => Org.Squadrons);

// ---- Stock lots: crafted items owned by a member or a squadron ----
// Saved to App_Data/lots.json next to the program.
var lots = new LotStore(Path.Combine(app.Environment.ContentRootPath, "App_Data", "lots.json"));

// Example: /api/lots?stage=Public&ownerKind=squadron&ownerId=901st&recipeId=...
app.MapGet("/api/lots", (string? stage, string? ownerKind, string? ownerId, string? recipeId) =>
    lots.List(stage, ownerKind, ownerId, recipeId));

app.MapGet("/api/lots/{id}", (string id) =>
    lots.Get(id) is { } lot ? Results.Ok(lot) : Results.NotFound());

// Body: { "recipeId": "...", "quality": 750, "quantity": 1, "madeByMemberId": "m-ash",
//         "forSquadron": true, "priceAuec": 12000, "kind": "WTS" }
// For an item that is not in the catalogue, leave recipeId out and send "customName" and "category"
// (one of CustomCategories.All) instead; "quality" is optional then. "notes" is optional for any post.
// kind: WTS (selling), WTB (buying: quality is the minimum, price the most you will pay),
//       WTT (trading: also send "wanted", what you want in exchange).
app.MapPost("/api/lots", (NewLot input) =>
{
    if (Org.FindMember(input.MadeByMemberId) is not { } member)
        return Results.BadRequest(new { error = "Unknown member." });
    if (input.Quality is < 0 or > 1000)
        return Results.BadRequest(new { error = "Quality must be 0-1000." });
    if (input.Quantity < 1)
        return Results.BadRequest(new { error = "Quantity must be at least 1." });
    if (input.ForSquadron && member.SquadronId is null)
        return Results.BadRequest(new { error = "That member is not in a squadron." });
    if (input.PriceAuec is < 0)
        return Results.BadRequest(new { error = "Price cannot be negative." });

    var kind = (input.Kind ?? LotKinds.Sell).Trim().ToUpperInvariant();
    if (!LotKinds.IsValid(kind))
        return Results.BadRequest(new { error = "Kind must be WTS, WTB or WTT." });
    if (kind != LotKinds.Sell && input.ForSquadron)
        return Results.BadRequest(new { error = "Only items for sale can be made for a squadron." });
    if (kind == LotKinds.Trade && string.IsNullOrWhiteSpace(input.Wanted))
        return Results.BadRequest(new { error = "Say what you want in exchange." });

    // The item is either a crafted one from the catalogue, or any other item the member names.
    string recipeId, itemName, itemType;
    if (!string.IsNullOrWhiteSpace(input.RecipeId))
    {
        if (bank.GetRecipe(input.RecipeId) is not { } recipe)
            return Results.BadRequest(new { error = "Unknown recipe." });
        if (input.Quality is null)
            return Results.BadRequest(new { error = "Quality is required for crafted items." });
        recipeId = recipe.Id;
        itemName = recipe.Name;
        itemType = recipe.Type;
    }
    else
    {
        var name = input.CustomName?.Trim();
        if (string.IsNullOrEmpty(name) || name.Length < 2 || name.Length > 80)
            return Results.BadRequest(new { error = "Give the item a name (2-80 characters)." });
        if (input.Category is null || !CustomCategories.All.Contains(input.Category))
            return Results.BadRequest(new { error = "Pick a category for the item." });
        if (input.ForSquadron)
            return Results.BadRequest(new { error = "Only crafted items can be made for a squadron." });
        recipeId = "";
        itemName = name;
        itemType = input.Category;
    }

    var notes = string.IsNullOrWhiteSpace(input.Notes) ? null : input.Notes.Trim();
    if (notes is { Length: > 300 })
        return Results.BadRequest(new { error = "Notes can be at most 300 characters." });

    // Squadron-made lots start on the release ladder; everything else is listed publicly.
    var lot = new Lot(
        Guid.NewGuid().ToString("N")[..8],
        recipeId,
        itemName,
        itemType,
        input.Quality,
        input.Quantity,
        input.ForSquadron ? "squadron" : "member",
        input.ForSquadron ? member.SquadronId! : member.Id,
        member.Id,
        input.ForSquadron ? LotStages.Squadron : LotStages.Public,
        input.PriceAuec,
        DateTime.UtcNow,
        null,
        kind,
        kind == LotKinds.Trade ? input.Wanted!.Trim() : null,
        notes);
    return Results.Created($"/api/lots/{lot.Id}", lots.Add(lot));
});

app.MapDelete("/api/lots/{id}", (string id) =>
    lots.Remove(id) ? Results.NoContent() : Results.NotFound());

// ---- Commodity prices from UEX (what terminals pay per SCU), fetched at most once a day ----
// The access token is read from the "Uex:Token" setting (see README), never stored in code.
var uex = new UexPrices(
    new HttpClient { Timeout = TimeSpan.FromSeconds(30) },
    app.Configuration["Uex:Token"],
    Path.Combine(app.Environment.ContentRootPath, "App_Data", "uex-prices.json"));

app.MapGet("/api/prices", async () =>
    await uex.GetAsync() is { } snapshot
        ? Results.Ok(snapshot)
        : Results.Problem("Commodity prices are not available yet. Check the Uex:Token setting and the internet connection.", statusCode: 503));

// Items players are selling on the UEX marketplace (asking prices), fetched at most once a day.
var uexListings = new UexListings(
    new HttpClient { Timeout = TimeSpan.FromSeconds(60) },
    app.Configuration["Uex:Token"],
    Path.Combine(app.Environment.ContentRootPath, "App_Data", "uex-listings.json"));

app.MapGet("/api/market-listings", async () =>
    await uexListings.GetAsync() is { } snapshot
        ? Results.Ok(snapshot)
        : Results.Problem("Marketplace listings are not available yet. Check the Uex:Token setting and the internet connection.", statusCode: 503));

// For checking what UEX really sends back, e.g. /api/uex-sample/marketplace_listings (shows the first few records).
app.MapGet("/api/uex-sample/{resource}", async (string resource) =>
    UexPrices.CanSample(resource) ? Results.Text(await uex.SampleAsync(resource)) : Results.NotFound());

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
