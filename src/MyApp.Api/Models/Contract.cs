using System.Text.Json;

namespace MyApp.Api.Models;

/// <summary>
/// A request for a crafting material: a member needs it and says what they will pay.
/// MinQuality 0 means any quality. Hot means urgent. Status is Open, Claimed (someone picked it up) or Done.
/// Quantity is in SCU for ores and metals, or units for harvestables.
/// </summary>
public record Contract(
    string Id,
    string Material,
    double Quantity,
    int MinQuality,
    int? RewardPerUnit,
    string PostedByMemberId,
    DateTime PostedAt,
    string Status,
    string? ClaimedByMemberId,
    bool Hot,
    string? Notes);

/// <summary>Body for posting a contract. Whoever is posting it is PostedByMemberId.</summary>
public record NewContract(
    string Material,
    double Quantity,
    int MinQuality,
    int? RewardPerUnit,
    string PostedByMemberId,
    bool Hot,
    string? Notes);

/// <summary>Body for picking up, putting back or finishing a contract: who is doing it.</summary>
public record MemberAction(string MemberId);

public static class ContractStatuses
{
    public const string Open = "Open";
    public const string Claimed = "Claimed";
    public const string Done = "Done";
}

/// <summary>Keeps contracts in memory and saves them to a JSON file so they survive a restart.</summary>
public class ContractStore
{
    static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web) { WriteIndented = true };

    readonly string _path;
    readonly object _lock = new();
    readonly List<Contract> _contracts;

    public ContractStore(string path)
    {
        _path = path;
        _contracts = File.Exists(path)
            ? JsonSerializer.Deserialize<List<Contract>>(File.ReadAllText(path), Json) ?? []
            : [];
    }

    /// <summary>Contracts, optionally of one status. Hot ones come first, then newest first.</summary>
    public List<Contract> List(string? status)
    {
        lock (_lock)
        {
            return _contracts
                .Where(c => status is null || c.Status == status)
                .OrderByDescending(c => c.Hot)
                .ThenByDescending(c => c.PostedAt)
                .ToList();
        }
    }

    public Contract? Get(string id)
    {
        lock (_lock) return _contracts.FirstOrDefault(c => c.Id == id);
    }

    public Contract Add(Contract contract)
    {
        lock (_lock)
        {
            _contracts.Add(contract);
            Save();
            return contract;
        }
    }

    /// <summary>Changes one contract and saves. Returns the new version, or null if it does not exist.</summary>
    public Contract? Update(string id, Func<Contract, Contract> change)
    {
        lock (_lock)
        {
            var i = _contracts.FindIndex(c => c.Id == id);
            if (i < 0) return null;
            _contracts[i] = change(_contracts[i]);
            Save();
            return _contracts[i];
        }
    }

    public bool Remove(string id)
    {
        lock (_lock)
        {
            var removed = _contracts.RemoveAll(c => c.Id == id) > 0;
            if (removed) Save();
            return removed;
        }
    }

    void Save()
    {
        Directory.CreateDirectory(Path.GetDirectoryName(_path)!);
        File.WriteAllText(_path, JsonSerializer.Serialize(_contracts, Json));
    }
}
