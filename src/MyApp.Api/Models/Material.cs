namespace MyApp.Api.Models;

/// <summary>
/// One fixed quality a material can be found at in the game (0-1000).
/// Tier is the label: F, E, D, C, B, A, S or Perfect.
/// </summary>
public record MaterialTier(string Tier, int Quality);

/// <summary>
/// A crafting material (ore or mineral) and the tiers it exists at.
/// Not every material has every tier, e.g. Carinite has no F tier.
/// </summary>
public record Material(string Name, string Category, List<MaterialTier> Tiers);
