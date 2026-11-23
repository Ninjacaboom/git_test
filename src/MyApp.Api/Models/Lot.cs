namespace MyApp.Api.Models;

/// <summary>
/// One crafted item (or a stack of identical ones) in stock.
/// OwnerKind is "member" or "squadron": squadron-made lots are crafted from pooled resources and
/// follow the release ladder; member-made lots belong to the person who made them.
/// Stage is Squadron, Priority, Public, Claimed or Sold.
/// Kind is WTS (want to sell: the item is in stock), WTB (want to buy: Quality is the minimum wanted and
/// PriceAuec the most the buyer will pay) or WTT (want to trade: Wanted says what is wanted in exchange).
/// Lots saved before kinds existed have no Kind and count as WTS.
/// Items that cannot be crafted (medals, attachments, looted armour...) have an empty RecipeId; ItemType
/// then holds their category, and Quality is null when the item has no quality.
/// </summary>
public record Lot(
    string Id,
    string RecipeId,
    string ItemName,
    string ItemType,
    int? Quality,
    int Quantity,
    string OwnerKind,
    string OwnerId,
    string MadeByMemberId,
    string Stage,
    int? PriceAuec,
    DateTime CreatedAt,
    DateTime? ReleaseAt,
    string Kind = "WTS",
    string? Wanted = null,
    string? Notes = null);

/// <summary>Body for creating a lot. Whoever is making it is MadeByMemberId.</summary>
public record NewLot(
    string? RecipeId,
    int? Quality,
    int Quantity,
    string MadeByMemberId,
    bool ForSquadron,
    int? PriceAuec,
    string? Kind = null,
    string? Wanted = null,
    string? CustomName = null,
    string? Category = null,
    string? Notes = null);

/// <summary>Categories for items that are not in the crafting catalogue.</summary>
public static class CustomCategories
{
    public static readonly string[] All =
    [
        "Medal",
        "Weapon attachment",
        "FPS weapon",
        "Ship weapon",
        "Railgun",
        "Armour (looted)",
        "Ship component",
        "Material",
        "Other",
    ];
}

public static class LotKinds
{
    public const string Sell = "WTS";
    public const string Buy = "WTB";
    public const string Trade = "WTT";

    public static bool IsValid(string kind) => kind is Sell or Buy or Trade;
}

public static class LotStages
{
    public const string Squadron = "Squadron";
    public const string Priority = "Priority";
    public const string Public = "Public";
    public const string Claimed = "Claimed";
    public const string Sold = "Sold";

    public static readonly string[] All = [Squadron, Priority, Public, Claimed, Sold];
}
