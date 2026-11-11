namespace MyApp.Api.Models;

/// <summary>The effect of material quality on one stat.</summary>
public record StatEffect(string Kind, double Value);

/// <summary>
/// Turns material quality (0-1000) into stat changes. 500 is the baseline.
/// Same rule as NovaTools: straight-line interpolation inside a modifier's quality range,
/// no change outside every range, multipliers multiply and additive values add.
/// </summary>
public static class QualityMath
{
    public const int Baseline = 500;
    public const int MinQuality = 0;
    public const int MaxQuality = 1000;

    /// <summary>Stat effects one slot gives at the given quality. Key is the stat name.</summary>
    public static Dictionary<string, StatEffect> SlotEffects(Slot slot, int quality)
    {
        var q = Math.Clamp(quality, MinQuality, MaxQuality);
        var result = new Dictionary<string, StatEffect>();

        foreach (var group in slot.Modifiers.GroupBy(m => m.Stat))
        {
            var kind = group.First().Kind;
            var additive = kind == "additive";
            var value = additive ? 0.0 : 1.0;

            foreach (var m in group)
            {
                if (q < m.QualityMin || q > m.QualityMax)
                {
                    continue;
                }

                var span = m.QualityMax - m.QualityMin;
                var fraction = span > 0 ? (double)(q - m.QualityMin) / span : 0.0;
                var x = m.ValueMin + fraction * (m.ValueMax - m.ValueMin);
                value = additive ? value + x : value * x;
            }

            result[group.Key] = new StatEffect(kind, value);
        }

        return result;
    }

    /// <summary>
    /// Combined stat effects for a whole recipe. qualityBySlot maps slot name to quality;
    /// slots that are missing from it are treated as baseline (500).
    /// </summary>
    public static Dictionary<string, StatEffect> RecipeEffects(
        Recipe recipe,
        IReadOnlyDictionary<string, int> qualityBySlot)
    {
        var total = new Dictionary<string, StatEffect>();

        foreach (var slot in recipe.Slots)
        {
            var quality = qualityBySlot.TryGetValue(slot.Name, out var chosen) ? chosen : Baseline;

            foreach (var (stat, effect) in SlotEffects(slot, quality))
            {
                if (!total.TryGetValue(stat, out var existing))
                {
                    total[stat] = effect;
                }
                else if (effect.Kind == "additive")
                {
                    total[stat] = new StatEffect(effect.Kind, existing.Value + effect.Value);
                }
                else
                {
                    total[stat] = new StatEffect(effect.Kind, existing.Value * effect.Value);
                }
            }
        }

        return total;
    }
}
