namespace MyApp.Api.Models;

/// <summary>A crafting resource. Material is the name in materials.json, or null if it has no quality tiers.</summary>
public record Resource(string Id, string Name, string Category, string UnitType, string? Material);

/// <summary>
/// How a slot's material quality changes a stat. Kind is "multiplier" or "additive".
/// Inside [QualityMin, QualityMax] the value runs in a straight line from ValueMin to ValueMax.
/// </summary>
public record Modifier(string Stat, string Kind, int QualityMin, int QualityMax, double ValueMin, double ValueMax);

/// <summary>What a slot costs. UnitType is "SCU" (mined ore) or "Units" (harvested items).</summary>
public record Cost(string ResourceId, string Material, string UnitType, double Quantity);

/// <summary>
/// Tiers is the list of qualities this slot's material can be used at.
/// F tier is left out except for mining lasers.
/// </summary>
public record Slot(string Name, string DisplayName, List<MaterialTier> Tiers, List<Cost> Costs, List<Modifier> Modifiers);

/// <summary>A skin variant of an item. RecipeId is set when the skin has its own recipe.</summary>
public record Skin(string ClassName, string? Name, string? RecipeId);

/// <summary>An extra item stat that is not in the description text (weapon damage, fire rate).</summary>
public record BaseStat(string Label, string Value);

public record Recipe(
    string Id,
    string ClassName,
    string Name,
    string? Description,
    string Type,
    string SubType,
    int Size,
    int? Grade,
    string? Manufacturer,
    int CraftTimeSeconds,
    string? VariantOf,
    List<Skin> Skins,
    List<Slot> Slots,
    List<BaseStat>? BaseStats = null,
    string? ArmourWeight = null,
    string? WeaponCategory = null);

/// <summary>Short form used for lists and search results.</summary>
public record RecipeSummary(
    string Id,
    string Name,
    string Type,
    string SubType,
    int Size,
    int? Grade,
    string? Manufacturer,
    bool IsSkin);

public record TypeCount(string Type, int Count);
