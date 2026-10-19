using System;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;
using Vincere.AutoExport.Agent.Updates;
using Xunit;

namespace Vincere.AutoExport.Agent.Tests;

/* THE UPDATER'S OWN HTTP: HTTPS AT EVERY HOP, AND NEVER MORE THAN ASKED FOR.
 *
 * Redirects are followed, because GitHub answers a release download with a 302
 * to its download host, and that is safe only because everything fetched is
 * pinned by digest. Plain HTTP is still refused, before the request and after
 * the last redirect. */
public sealed class HttpUpdateDownloaderTests
{
    private static readonly Uri Release = new("https://github.com/2069936/CAM-CRM-Vincere/releases/download/agent-v1.3.1/release-manifest.json");

    [Fact]
    public async Task The_body_is_returned()
    {
        StubHandler handler = new(_ => Ok(new byte[] { 1, 2, 3 }));
        using HttpUpdateDownloader downloader = new(handler, disposeHandler: false);

        byte[] body = await downloader.GetBytesAsync(Release, 1024, TimeSpan.FromSeconds(5), CancellationToken.None);

        Assert.Equal(new byte[] { 1, 2, 3 }, body);
        Assert.Single(handler.Requests);
    }

    [Fact]
    public async Task A_plain_http_address_is_refused_without_a_request()
    {
        StubHandler handler = new(_ => Ok(new byte[] { 1 }));
        using HttpUpdateDownloader downloader = new(handler, disposeHandler: false);

        UpdateDownloadException error = await Assert.ThrowsAsync<UpdateDownloadException>(() =>
            downloader.GetBytesAsync(new Uri("http://github.com/x"), 1024, TimeSpan.FromSeconds(5), CancellationToken.None));

        Assert.Equal(UpdateDownloadFailure.Unreachable, error.Failure);
        Assert.Empty(handler.Requests);
    }

    [Fact]
    public async Task A_redirect_that_ends_on_plain_http_is_refused()
    {
        // What the response looks like after the handler followed redirects:
        // its RequestMessage carries the last address it went to.
        StubHandler handler = new(request =>
        {
            HttpResponseMessage response = Ok(new byte[] { 1 });
            response.RequestMessage = new HttpRequestMessage(HttpMethod.Get, "http://objects.example.test/file");
            return response;
        });
        using HttpUpdateDownloader downloader = new(handler, disposeHandler: false);

        UpdateDownloadException error = await Assert.ThrowsAsync<UpdateDownloadException>(() =>
            downloader.GetBytesAsync(Release, 1024, TimeSpan.FromSeconds(5), CancellationToken.None));

        Assert.Equal(UpdateDownloadFailure.Unreachable, error.Failure);
    }

    [Fact]
    public async Task A_redirect_that_stays_on_https_is_followed()
    {
        StubHandler handler = new(request =>
        {
            HttpResponseMessage response = Ok(new byte[] { 7 });
            response.RequestMessage = new HttpRequestMessage(HttpMethod.Get, "https://objects.githubusercontent.com/file");
            return response;
        });
        using HttpUpdateDownloader downloader = new(handler, disposeHandler: false);

        byte[] body = await downloader.GetBytesAsync(Release, 1024, TimeSpan.FromSeconds(5), CancellationToken.None);

        Assert.Equal(new byte[] { 7 }, body);
    }

    [Fact]
    public async Task A_declared_length_over_the_limit_is_refused_before_reading()
    {
        StubHandler handler = new(_ => Ok(new byte[2048]));
        using HttpUpdateDownloader downloader = new(handler, disposeHandler: false);

        UpdateDownloadException error = await Assert.ThrowsAsync<UpdateDownloadException>(() =>
            downloader.GetBytesAsync(Release, 1024, TimeSpan.FromSeconds(5), CancellationToken.None));

        Assert.Equal(UpdateDownloadFailure.TooLarge, error.Failure);
    }

    [Fact]
    public async Task A_body_longer_than_the_limit_without_a_length_is_cut_off()
    {
        StubHandler handler = new(_ => new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = new StreamContent(new UnseekableStream(new byte[4096])),
        });
        using HttpUpdateDownloader downloader = new(handler, disposeHandler: false);
        using MemoryStream destination = new();

        UpdateDownloadException error = await Assert.ThrowsAsync<UpdateDownloadException>(() =>
            downloader.CopyToAsync(Release, destination, 1024, TimeSpan.FromSeconds(5), CancellationToken.None));

        Assert.Equal(UpdateDownloadFailure.TooLarge, error.Failure);
        Assert.True(destination.Length <= 1024);
    }

    [Theory]
    [InlineData(HttpStatusCode.NotFound)]
    [InlineData(HttpStatusCode.InternalServerError)]
    [InlineData(HttpStatusCode.Forbidden)]
    public async Task A_refused_download_is_unreachable(HttpStatusCode status)
    {
        StubHandler handler = new(_ => new HttpResponseMessage(status) { Content = new ByteArrayContent(Array.Empty<byte>()) });
        using HttpUpdateDownloader downloader = new(handler, disposeHandler: false);

        UpdateDownloadException error = await Assert.ThrowsAsync<UpdateDownloadException>(() =>
            downloader.GetBytesAsync(Release, 1024, TimeSpan.FromSeconds(5), CancellationToken.None));

        Assert.Equal(UpdateDownloadFailure.Unreachable, error.Failure);
    }

    [Fact]
    public async Task A_connection_failure_is_unreachable()
    {
        StubHandler handler = new(_ => throw new HttpRequestException("connection refused"));
        using HttpUpdateDownloader downloader = new(handler, disposeHandler: false);

        UpdateDownloadException error = await Assert.ThrowsAsync<UpdateDownloadException>(() =>
            downloader.GetBytesAsync(Release, 1024, TimeSpan.FromSeconds(5), CancellationToken.None));

        Assert.Equal(UpdateDownloadFailure.Unreachable, error.Failure);
    }

    private static HttpResponseMessage Ok(byte[] body) => new(HttpStatusCode.OK)
    {
        Content = new ByteArrayContent(body),
    };

    private sealed class StubHandler : HttpMessageHandler
    {
        private readonly Func<HttpRequestMessage, HttpResponseMessage> respond;

        public StubHandler(Func<HttpRequestMessage, HttpResponseMessage> respond) => this.respond = respond;

        public List<Uri> Requests { get; } = new();

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Requests.Add(request.RequestUri);
            HttpResponseMessage response = respond(request);
            response.RequestMessage ??= request;
            return Task.FromResult(response);
        }
    }

    /// <summary>A body whose length is not known up front, like a chunked response.</summary>
    private sealed class UnseekableStream : MemoryStream
    {
        public UnseekableStream(byte[] buffer) : base(buffer)
        {
        }

        public override bool CanSeek => false;
    }
}
