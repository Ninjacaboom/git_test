using System.Net.Http.Headers;
using System.Text.Json;

namespace MyApp.Api.Models;

/// <summary>What commodity terminals pay for one commodity (aUEC per SCU), summed up from UEX reports.</summary>
public record CommodityPrice(string Name, int? BestSell, int? AvgSell, int Terminals, long? Updated);

public record PriceSnapshot(DateTime FetchedAt, string Source, List<CommodityPrice> Prices);

/// <summary>
/// Commodity prices from the UEX community API (https://uexcorp.space/api).
/// Fetched at most once a day and saved to App_Data so a restart does not use up the daily quota.
/// The access token is optional here: it is read from the "Uex:Token" setting, never from code.
/// </summary>
public class UexPrices
{
    const string Url = "https://api.uexcorp.uk/2.0/commodities_prices_all/";
    static readonly TimeSpan MaxAge = TimeSpan.FromHours(24);
    static readonly TimeSpan RetryAfter = TimeSpan.FromHours(1);
    static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web) { WriteIndented = true };

    readonly HttpClient _http;
    readonly string? _token;
    readonly string _path;
    readonly SemaphoreSlim _gate = new(1, 1);
    PriceSnapshot? _snapshot;
    DateTime _lastAttempt = DateTime.MinValue;

    public UexPrices(HttpClient http, string? token, string path)
    {
        _http = http;
        _token = string.IsNullOrWhiteSpace(token) ? null : token.Trim();
        _path = path;
        if (File.Exists(path))
        {
            try { _snapshot = JsonSerializer.Deserialize<PriceSnapshot>(File.ReadAllText(path), Json); }
            catch (JsonException) { _snapshot = null; }
        }
    }

    static readonly HashSet<string> SampleResources = new(StringComparer.OrdinalIgnoreCase)
    {
        "marketplace_listings", "marketplace_averages", "marketplace_averages_all",
        "marketplace_prices_averages", "marketplace_prices_averages_all", "marketplace_trends",
        "items", "items_prices_all", "categories",
    };

    /// <summary>Only a few harmless read-only endpoints can be sampled.</summary>
    public static bool CanSample(string resource) => SampleResources.Contains(resource);

    /// <summary>
    /// The first part of a UEX response as plain text, so the real field names can be checked while building.
    /// Not cached; it is for looking at, not for the site to use.
    /// </summary>
    public async Task<string> SampleAsync(string resource)
    {
        try
        {
            using var request = new HttpRequestMessage(HttpMethod.Get, $"https://api.uexcorp.uk/2.0/{resource}/");
            if (_token is not null) request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", _token);
            using var response = await _http.SendAsync(request);
            var body = await response.Content.ReadAsStringAsync();
            var shown = body.Length > 6000 ? body[..6000] + "\n... (cut off, " + body.Length + " characters in total)" : body;
            return $"HTTP {(int)response.StatusCode} from {resource}\n\n{shown}";
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException)
        {
            return $"Could not reach UEX: {ex.Message}";
        }
    }

    /// <summary>The latest prices, refreshed if they are over a day old. Null if there are none yet.</summary>
    public async Task<PriceSnapshot?> GetAsync()
    {
        await _gate.WaitAsync();
        try
        {
            var stale = _snapshot is null || DateTime.UtcNow - _snapshot.FetchedAt > MaxAge;
            if (stale && DateTime.UtcNow - _lastAttempt > RetryAfter)
            {
                _lastAttempt = DateTime.UtcNow;
                try
                {
                    _snapshot = await Fetch();
                    Directory.CreateDirectory(Path.GetDirectoryName(_path)!);
                    File.WriteAllText(_path, JsonSerializer.Serialize(_snapshot, Json));
                }
                catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or JsonException)
                {
                    // Keep whatever we already have; try again in an hour.
                }
            }
            return _snapshot;
        }
        finally
        {
            _gate.Release();
        }
    }

    async Task<PriceSnapshot> Fetch()
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, Url);
        if (_token is not null) request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", _token);

        using var response = await _http.SendAsync(request);
        response.EnsureSuccessStatusCode();

        using var doc = await JsonDocument.ParseAsync(await response.Content.ReadAsStreamAsync());
        if (!doc.RootElement.TryGetProperty("data", out var data) || data.ValueKind != JsonValueKind.Array)
            throw new JsonException("Unexpected response from UEX.");

        var byName = new Dictionary<string, Accumulator>(StringComparer.OrdinalIgnoreCase);
        foreach (var row in data.EnumerateArray())
        {
            var name = Text(row, "commodity_name");
            if (string.IsNullOrWhiteSpace(name)) continue;

            var last = Number(row, "price_sell");
            var avg = Number(row, "price_sell_avg");
            var value = avg > 0 ? avg : last; // prefer the average over a single report
            if (value <= 0) continue;         // this terminal does not buy it

            if (!byName.TryGetValue(name, out var acc)) byName[name] = acc = new Accumulator();
            acc.Values.Add(value);
            acc.Best = Math.Max(acc.Best, last > 0 ? last : value);
            var updated = (long)Number(row, "date_modified");
            if (updated > acc.Updated) acc.Updated = updated;
        }

        var prices = byName
            .OrderBy(kv => kv.Key, StringComparer.OrdinalIgnoreCase)
            .Select(kv => new CommodityPrice(
                kv.Key,
                (int)Math.Round(kv.Value.Best),
                (int)Math.Round(kv.Value.Values.Average()),
                kv.Value.Values.Count,
                kv.Value.Updated > 0 ? kv.Value.Updated : null))
            .ToList();

        return new PriceSnapshot(DateTime.UtcNow, "UEX", prices);
    }

    sealed class Accumulator
    {
        public List<double> Values { get; } = [];
        public double Best { get; set; }
        public long Updated { get; set; }
    }

    static string? Text(JsonElement row, string name) =>
        row.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;

    static double Number(JsonElement row, string name)
    {
        if (!row.TryGetProperty(name, out var v)) return 0;
        return v.ValueKind switch
        {
            JsonValueKind.Number => v.GetDouble(),
            JsonValueKind.String when double.TryParse(v.GetString(), System.Globalization.NumberStyles.Float,
                System.Globalization.CultureInfo.InvariantCulture, out var d) => d,
            _ => 0,
        };
    }
}
