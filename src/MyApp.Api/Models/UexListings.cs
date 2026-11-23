using System.Net.Http.Headers;
using System.Text.Json;

namespace MyApp.Api.Models;

/// <summary>One player listing from the UEX marketplace. Quality is null when the seller did not give one.</summary>
public record MarketListing(string Title, int? ItemId, int? CategoryId, int? Quality, long Price, int Stock, long? Added);

public record ListingSnapshot(DateTime FetchedAt, string Source, List<MarketListing> Listings);

/// <summary>
/// Items players are selling on the UEX marketplace (https://uexcorp.space/api, "marketplace_listings").
/// These are asking prices, not completed sales. Fetched at most once a day and saved to App_Data.
/// </summary>
public class UexListings
{
    const string Url = "https://api.uexcorp.uk/2.0/marketplace_listings/";
    static readonly TimeSpan MaxAge = TimeSpan.FromHours(24);
    static readonly TimeSpan RetryAfter = TimeSpan.FromHours(1);
    static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    readonly HttpClient _http;
    readonly string? _token;
    readonly string _path;
    readonly SemaphoreSlim _gate = new(1, 1);
    ListingSnapshot? _snapshot;
    DateTime _lastAttempt = DateTime.MinValue;

    public UexListings(HttpClient http, string? token, string path)
    {
        _http = http;
        _token = string.IsNullOrWhiteSpace(token) ? null : token.Trim();
        _path = path;
        if (File.Exists(path))
        {
            try { _snapshot = JsonSerializer.Deserialize<ListingSnapshot>(File.ReadAllText(path), Json); }
            catch (JsonException) { _snapshot = null; }
        }
    }

    public async Task<ListingSnapshot?> GetAsync()
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
                    // Keep the old listings; try again in an hour.
                }
            }
            return _snapshot;
        }
        finally
        {
            _gate.Release();
        }
    }

    async Task<ListingSnapshot> Fetch()
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, Url);
        if (_token is not null) request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", _token);

        using var response = await _http.SendAsync(request);
        response.EnsureSuccessStatusCode();

        using var doc = await JsonDocument.ParseAsync(await response.Content.ReadAsStreamAsync());
        if (!doc.RootElement.TryGetProperty("data", out var data) || data.ValueKind != JsonValueKind.Array)
            throw new JsonException("Unexpected response from UEX.");

        var listings = new List<MarketListing>();
        foreach (var row in data.EnumerateArray())
        {
            // Only things for sale, still available, priced in aUEC.
            if (!string.Equals(UexPrices.Text(row, "operation"), "sell", StringComparison.OrdinalIgnoreCase)) continue;
            if (UexPrices.Number(row, "is_sold_out") != 0) continue;
            var currency = UexPrices.Text(row, "currency");
            if (currency is not null && !string.Equals(currency, "UEC", StringComparison.OrdinalIgnoreCase)) continue;

            var title = UexPrices.Text(row, "title");
            var price = (long)UexPrices.Number(row, "price");
            if (string.IsNullOrWhiteSpace(title) || price <= 0) continue;

            listings.Add(new MarketListing(
                title.Trim(),
                OptInt(row, "id_item"),
                OptInt(row, "id_category"),
                OptInt(row, "quality"),
                price,
                Math.Max(1, (int)UexPrices.Number(row, "in_stock")),
                row.TryGetProperty("date_added", out _) ? (long)UexPrices.Number(row, "date_added") : null));
        }

        return new ListingSnapshot(DateTime.UtcNow, "UEX", listings);
    }

    static int? OptInt(JsonElement row, string name) =>
        row.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Number ? (int)v.GetDouble() : null;
}
