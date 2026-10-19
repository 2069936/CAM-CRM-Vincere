using System;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Threading;
using System.Threading.Tasks;

namespace Vincere.AutoExport.Agent.Updates;

public enum UpdateDownloadFailure
{
    /// <summary>Not HTTPS, a refused or failed connection, a non-2xx answer, or a timeout.</summary>
    Unreachable,

    /// <summary>The body was longer than the caller allowed.</summary>
    TooLarge,
}

public sealed class UpdateDownloadException : Exception
{
    public UpdateDownloadException(UpdateDownloadFailure failure, string message, Exception innerException = null)
        : base(message, innerException)
    {
        Failure = failure;
    }

    public UpdateDownloadFailure Failure { get; }
}

/// <summary>
/// The network, for the updater only. Both methods refuse anything but HTTPS,
/// before and after redirects, and stop reading at the caller's limit.
/// </summary>
public interface IUpdateDownloader
{
    Task<byte[]> GetBytesAsync(
        Uri uri,
        int maximumBytes,
        TimeSpan timeout,
        CancellationToken cancellationToken);

    /// <returns>How many bytes were written to <paramref name="destination"/>.</returns>
    Task<long> CopyToAsync(
        Uri uri,
        Stream destination,
        long maximumBytes,
        TimeSpan timeout,
        CancellationToken cancellationToken);
}

/* ITS OWN HTTP CLIENT, NOT THE CRM'S.
 *
 * The CRM client refuses redirects, which is right for the CRM and wrong here:
 * a GitHub release download answers 302 to objects.githubusercontent.com. That
 * is safe to follow because nothing downloaded here is trusted for where it came
 * from. The manifest is pinned by the digest the CRM sent and the package by the
 * digest in that manifest, so a redirect to anywhere can only produce bytes that
 * fail a hash. What is still refused is plain HTTP at any hop: SocketsHttpHandler
 * will not follow an HTTPS to HTTP redirect, and the final address is checked
 * here as well. */
public sealed class HttpUpdateDownloader : IUpdateDownloader, IDisposable
{
    private const int BufferSize = 81920;
    private readonly HttpClient httpClient;

    public HttpUpdateDownloader(HttpMessageHandler handler, bool disposeHandler)
    {
        httpClient = new HttpClient(
            handler ?? throw new ArgumentNullException(nameof(handler)),
            disposeHandler)
        {
            Timeout = Timeout.InfiniteTimeSpan,
        };
        httpClient.DefaultRequestHeaders.UserAgent.Add(new ProductInfoHeaderValue("Vincere-AutoExport-Agent", "1"));
    }

    public static HttpUpdateDownloader CreateProduction()
    {
        SocketsHttpHandler handler = new()
        {
            AllowAutoRedirect = true,
            MaxAutomaticRedirections = 5,
            AutomaticDecompression = DecompressionMethods.None,
            ConnectTimeout = TimeSpan.FromSeconds(30),
            PooledConnectionLifetime = TimeSpan.FromMinutes(5),
        };
        return new HttpUpdateDownloader(handler, disposeHandler: true);
    }

    public async Task<byte[]> GetBytesAsync(
        Uri uri,
        int maximumBytes,
        TimeSpan timeout,
        CancellationToken cancellationToken)
    {
        if (maximumBytes <= 0) throw new ArgumentOutOfRangeException(nameof(maximumBytes));
        using MemoryStream buffer = new();
        await CopyToAsync(uri, buffer, maximumBytes, timeout, cancellationToken).ConfigureAwait(false);
        return buffer.ToArray();
    }

    public async Task<long> CopyToAsync(
        Uri uri,
        Stream destination,
        long maximumBytes,
        TimeSpan timeout,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(destination);
        if (maximumBytes <= 0) throw new ArgumentOutOfRangeException(nameof(maximumBytes));
        if (timeout <= TimeSpan.Zero) throw new ArgumentOutOfRangeException(nameof(timeout));
        if (uri == null || !uri.IsAbsoluteUri || uri.Scheme != Uri.UriSchemeHttps)
            throw new UpdateDownloadException(UpdateDownloadFailure.Unreachable, "Only HTTPS downloads are allowed.");

        using CancellationTokenSource limit = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        limit.CancelAfter(timeout);
        try
        {
            using HttpRequestMessage request = new(HttpMethod.Get, uri);
            using HttpResponseMessage response = await httpClient
                .SendAsync(request, HttpCompletionOption.ResponseHeadersRead, limit.Token)
                .ConfigureAwait(false);
            Uri finalUri = response.RequestMessage?.RequestUri ?? uri;
            if (finalUri.Scheme != Uri.UriSchemeHttps)
                throw new UpdateDownloadException(UpdateDownloadFailure.Unreachable, "A redirect left HTTPS.");
            if (!response.IsSuccessStatusCode)
                throw new UpdateDownloadException(UpdateDownloadFailure.Unreachable, "The download was refused.");
            if (response.Content.Headers.ContentLength is long declared && declared > maximumBytes)
                throw new UpdateDownloadException(UpdateDownloadFailure.TooLarge, "The download is larger than allowed.");

            using Stream body = await response.Content.ReadAsStreamAsync(limit.Token).ConfigureAwait(false);
            byte[] chunk = new byte[BufferSize];
            long total = 0;
            while (true)
            {
                int read;
                // A connection dropped mid-body surfaces as an IOException from
                // the response stream, and that is the network. A failure writing
                // to the destination is NOT caught here: the caller knows whether
                // it was the disk.
                try
                {
                    read = await body.ReadAsync(chunk.AsMemory(0, chunk.Length), limit.Token).ConfigureAwait(false);
                }
                catch (IOException exception)
                {
                    throw new UpdateDownloadException(
                        UpdateDownloadFailure.Unreachable,
                        "The download was interrupted.",
                        exception);
                }
                if (read == 0) break;
                total += read;
                if (total > maximumBytes)
                    throw new UpdateDownloadException(UpdateDownloadFailure.TooLarge, "The download is larger than allowed.");
                await destination.WriteAsync(chunk.AsMemory(0, read), limit.Token).ConfigureAwait(false);
            }
            return total;
        }
        catch (OperationCanceledException exception) when (!cancellationToken.IsCancellationRequested)
        {
            throw new UpdateDownloadException(UpdateDownloadFailure.Unreachable, "The download timed out.", exception);
        }
        catch (HttpRequestException exception)
        {
            throw new UpdateDownloadException(UpdateDownloadFailure.Unreachable, "The download failed.", exception);
        }
    }

    public void Dispose()
    {
        httpClient.Dispose();
    }
}
