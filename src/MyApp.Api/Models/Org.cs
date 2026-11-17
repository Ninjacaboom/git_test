namespace MyApp.Api.Models;

/// <summary>A squadron (e.g. the 901st MEU). Division is one of Defence, Core, Relief, Skyline, Frontiers.</summary>
public record Squadron(string Id, string Name, string Division);

/// <summary>A member. SquadronId is null for members who are not in a squadron.</summary>
public record Member(string Id, string Name, string? SquadronId, string Division);

/// <summary>
/// Stand-in people for development. When the site is hosted inside the NOVA portal, the portal
/// supplies the current member and squadron, and this list goes away.
/// </summary>
public static class Org
{
    public static readonly IReadOnlyList<Squadron> Squadrons =
    [
        new("901st", "901st MEU", "Defence"),
        new("naf-1", "NAF 1st Wing", "Defence"),
        new("core-a", "Core Industrial", "Core"),
        new("relief-a", "Relief Medical", "Relief"),
        new("frontiers-a", "Frontiers Expedition", "Frontiers"),
    ];

    public static readonly IReadOnlyList<Member> Members =
    [
        new("m-ash", "Ash (901st)", "901st", "Defence"),
        new("m-kestrel", "Kestrel (NAF)", "naf-1", "Defence"),
        new("m-rook", "Rook (Core)", "core-a", "Core"),
        new("m-wren", "Wren (Relief)", "relief-a", "Relief"),
        new("m-fox", "Fox (Frontiers)", "frontiers-a", "Frontiers"),
        new("m-solo", "Solo (no squadron)", null, "Core"),
    ];

    public static Member? FindMember(string? id) => Members.FirstOrDefault(m => m.Id == id);
    public static Squadron? FindSquadron(string? id) => Squadrons.FirstOrDefault(s => s.Id == id);
}
