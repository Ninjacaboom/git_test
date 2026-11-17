using System.Text.Json;

namespace MyApp.Api.Models;

/// <summary>Keeps lots in memory and saves them to a JSON file so they survive a restart.</summary>
public class LotStore
{
    static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web) { WriteIndented = true };

    readonly string _path;
    readonly object _lock = new();
    readonly List<Lot> _lots;

    public LotStore(string path)
    {
        _path = path;
        _lots = File.Exists(path)
            ? JsonSerializer.Deserialize<List<Lot>>(File.ReadAllText(path), Json) ?? []
            : [];
    }

    public List<Lot> List(string? stage, string? ownerKind, string? ownerId, string? recipeId)
    {
        lock (_lock)
        {
            return _lots
                .Where(l => stage is null || l.Stage == stage)
                .Where(l => ownerKind is null || l.OwnerKind == ownerKind)
                .Where(l => ownerId is null || l.OwnerId == ownerId)
                .Where(l => recipeId is null || l.RecipeId == recipeId)
                .OrderByDescending(l => l.CreatedAt)
                .ToList();
        }
    }

    public Lot? Get(string id)
    {
        lock (_lock) return _lots.FirstOrDefault(l => l.Id == id);
    }

    public Lot Add(Lot lot)
    {
        lock (_lock)
        {
            _lots.Add(lot);
            Save();
            return lot;
        }
    }

    public bool Remove(string id)
    {
        lock (_lock)
        {
            var removed = _lots.RemoveAll(l => l.Id == id) > 0;
            if (removed) Save();
            return removed;
        }
    }

    void Save()
    {
        Directory.CreateDirectory(Path.GetDirectoryName(_path)!);
        File.WriteAllText(_path, JsonSerializer.Serialize(_lots, Json));
    }
}
