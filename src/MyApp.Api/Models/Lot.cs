namespace MyApp.Api.Models;

/// <summary>
/// One crafted item (or a stack of identical ones) in stock.
/// OwnerKind is "member" or "squadron": squadron-made lots are crafted from pooled resources and
/// follow the release ladder; member-made lots belong to the person who made them.
/// Stage is Squadron, Priority, Public, Claimed or Sold.
/// </summary>
public record Lot(
    string Id,
    string RecipeId,
    string ItemName,
    string ItemType,
    int Quality,
    int Quantity,
    string OwnerKind,
    string OwnerId,
    string MadeByMemberId,
    string Stage,
    int? PriceAuec,
    DateTime CreatedAt,
    DateTime? ReleaseAt);

/// <summary>Body for creating a lot. Whoever is making it is MadeByMemberId.</summary>
public record NewLot(
    string RecipeId,
    int Quality,
    int Quantity,
    string MadeByMemberId,
    bool ForSquadron,
    int? PriceAuec);

public static class LotStages
{
    public const string Squadron = "Squadron";
    public const string Priority = "Priority";
    public const string Public = "Public";
    public const string Claimed = "Claimed";
    public const string Sold = "Sold";

    public static readonly string[] All = [Squadron, Priority, Public, Claimed, Sold];
}
