using System.Text.Json;

namespace MyApp.Api.Models;

/// <summary>
/// All the game reference data (materials, resources, recipes), loaded once at startup
/// from the JSON files in the Data folder. This is read-only; member stock and orders
/// will live in a database later.
/// </summary>
public class DataBank
{
    private readonly Dictionary<string, Recipe> _recipesById;
    private readonly Dictionary<string, Material> _materialsByName;
    private readonly HashSet<string> _classNames;

    public IReadOnlyList<Material> Materials { get; }
    public IReadOnlyList<Resource> Resources { get; }
    public IReadOnlyList<Recipe> Recipes { get; }

    private DataBank(List<Material> materials, List<Resource> resources, List<Recipe> recipes)
    {
        Materials = materials;
        Resources = resources;
        Recipes = recipes;
        _recipesById = recipes.ToDictionary(r => r.Id);
        _classNames = recipes.Select(r => r.ClassName).ToHashSet();
        _materialsByName = materials.ToDictionary(m => m.Name, StringComparer.OrdinalIgnoreCase);
    }

    public static DataBank Load(string dataDirectory)
    {
        var options = new JsonSerializerOptions(JsonSerializerDefaults.Web);

        T Read<T>(string file)
        {
            var path = Path.Combine(dataDirectory, file);
            return JsonSerializer.Deserialize<T>(File.ReadAllText(path), options)
                ?? throw new InvalidOperationException($"{file} is empty or invalid.");
        }

        return new DataBank(
            Read<List<Material>>("materials.json"),
            Read<List<Resource>>("resources.json"),
            Read<List<Recipe>>("recipes.json"));
    }

    public Recipe? GetRecipe(string id) =>
        _recipesById.TryGetValue(id, out var recipe) ? recipe : null;

    public Material? GetMaterial(string name) =>
        _materialsByName.TryGetValue(name, out var material) ? material : null;

    /// <summary>Search recipes by name or manufacturer text, optionally limited to one type.</summary>
    public IEnumerable<RecipeSummary> Search(string? text, string? type, bool includeSkins = true)
    {
        IEnumerable<Recipe> query = Recipes;

        if (!string.IsNullOrWhiteSpace(type))
        {
            query = query.Where(r => r.Type.Equals(type, StringComparison.OrdinalIgnoreCase));
        }

        if (!string.IsNullOrWhiteSpace(text))
        {
            query = query.Where(r =>
                r.Name.Contains(text, StringComparison.OrdinalIgnoreCase) ||
                (r.Manufacturer != null && r.Manufacturer.Contains(text, StringComparison.OrdinalIgnoreCase)));
        }

        if (!includeSkins)
        {
            query = query.Where(r => !IsSkin(r));
        }

        return query.Select(r => new RecipeSummary(
            r.Id, r.Name, r.Type, r.SubType, r.Size, r.Grade, r.Manufacturer, IsSkin(r)));
    }

    /// <summary>
    /// A skin is a variant of an item that has its own recipe. A variant whose base item has no recipe
    /// (for example the Skarnov "Raider Camo" Rifle) is the only way to craft that item, so it counts as a normal item.
    /// </summary>
    private bool IsSkin(Recipe r) => r.VariantOf != null && _classNames.Contains(r.VariantOf);

    public IEnumerable<TypeCount> RecipeTypes() =>
        Recipes
            .GroupBy(r => r.Type)
            .Select(g => new TypeCount(g.Key, g.Count()))
            .OrderBy(t => t.Type);
}
