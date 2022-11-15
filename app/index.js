const fs = require('fs');
const path = require('path')

const Mutex = require('async-mutex').Mutex;
const compression = require('compression');
const express = require("express");
const puppeteer = require("puppeteer");
const redis = require("redis");

const PORT = process.env.PORT || 3000;


let redisClient;

(async () => {
    redisClient = redis.createClient();
    redisClient.on("error", (error) => console.error(`Error : ${error}`));
    await redisClient.connect();
})();


app = express();

// Use gzip-compression. It might be nice if we pre-compressed the static assets
// instead of using CPU on the fly, but practically the level of CPU used is
// very small.
app.use(compression())

//setting view engine to ejs
app.set("view engine", "ejs");

app.use(express.static('public'));

//route for index page
app.get("/", function (req, res) {
    let urlStr = 'https://gpsjam.org';
    urlStr += req.url;
    let previewUrl = 'https://gpsjam.org/images/gpsjam-card-preview.png';
    let previewDesc = "Maps showing daily possible GPS interference.";

    const url = new URL(urlStr);
    const params = url.searchParams;
    const zoom = parseFloat(params.get('z')) - 1.0;
    const lat = parseFloat(params.get('lat'));
    const lon = parseFloat(params.get('lon'));
    if (lat && lon && zoom) {
        previewDesc = "Map showing possible GPS interference around " + lat.toFixed(3) + ", " + lon.toFixed(3) + ".";
        previewUrl = 'https://gpsjam.org/preview?u=' + encodeURIComponent(urlStr);
    }
    res.render("index", { url: urlStr, previewUrl, previewDesc });
});


//route for magic page
app.get("/magic", function (req, res) {
    res.render("magic");
});


app.listen(PORT, function () {
    console.log(`Server is running on port ${PORT}`);
});


// This preview screenshot generator does 3 things:
// 1. Uses puppeteer to render the page at a given URL and return a PNG.
// 2. Serializes puppeteer usage so we only screenshot one page at a time, to
//    keep memory usage down.
// 3. Caches screenshots (in redis) so we don't have to re-render a particular
//    URL every time.
class Previewer {
    constructor() {
        this.browser = null;
        this.browserUseCount = 0;
        this.cacheHits = 0;
        this.cacheMisses = 0;
        this.browserMutex = new Mutex();
        this.urlsInProgress = {};
    }

    async getPreview(url) {
        const urlStr = url.toString();
        return new Promise(async (resolve, reject) => {
            const cachedImage = await redisClient.get(redis.commandOptions({ returnBuffers: true }), urlStr);
            if (cachedImage) {
                // If the url is already in the cache, we're done.
                this.cacheHits += 1;
                console.log(`Cache hit for screenshot of url ${url}. Hit rate ${(this.cacheHits / (this.cacheHits + this.cacheMisses)).toFixed(2)}`);
                resolve(cachedImage);
            } else {
                if (this.urlsInProgress[urlStr]) {
                    // If someone else is already rendering this url, wait for
                    // them to finish then get it from the cache.
                    this.urlsInProgress[urlStr].push({ resolve, reject });
                    console.log(`Waiting for screenshot of ${url}, already in progress. Queue has ${Object.keys(this.urlsInProgress).length} items.`);
                } else {
                    // OK, fine, it's up to us to render this url.
                    this.cacheMisses += 1;
                    console.log(`Getting screenshot of ${url}. Cache hit rate ${(this.cacheHits / (this.cacheHits + this.cacheMisses)).toFixed(2)}`);
                    this.urlsInProgress[urlStr] = [{ resolve, reject }];
                    try {
                        const image = await this.getPreviewInternal(url);
                        await redisClient.set(urlStr, image);
                        console.log(`Queue has ${Object.keys(this.urlsInProgress).length - 1} entries.`);
                        // Notify anyone else who was waiting for this url (since
                        // we've put the image in the cache, no more requests will
                        // be added to the queue for this url so urlsInProgress
                        // won't be changed under our noses).
                        this.urlsInProgress[urlStr].forEach(({ resolve, reject }) => {
                            resolve(image);
                        });
                    }
                    catch (e) {
                        console.error(`Error getting screenshot of ${url}: ${e}`);
                        this.urlsInProgress[urlStr].forEach(({ resolve, reject }) => {
                            reject(e);
                        });
                    }
                    delete this.urlsInProgress[urlStr];
                }
            }
        });
    }

    async getPreviewInternal(url) {
        const startTime = Date.now();
        // Use the browserMutex to ensure we only ever screenshot one url at a
        // time.
        return await this.browserMutex.runExclusive(async () => {
            if (!this.browser || this.browserUseCount > 10) {
                // Not sure if this is necessary, but just in case let's create
                // a fresh browser after every 10 screenshots.
                console.log('Creating new browser');
                if (this.browser) {
                    console.log('Closing old browser');
                    await this.browser.close();
                }
                this.browser = await puppeteer.launch({
                    headless: true,
                    // Seems like we need to disable the sandbox to get this to
                    // work with most cloud providers (Vercel, bitnami).
                    args: ['--no-sandbox', '--disable-setuid-sandbox'],
                });
                this.browserUseCount = 0;
            }
            const page = await this.browser.newPage();
            // Log messages from the page to the server console.
            page.on('console', async (msg) => {
                const msgArgs = msg.args();
                for (let i = 0; i < msgArgs.length; ++i) {
                    console.log(await msgArgs[i].jsonValue());
                }
            });

            this.browserUseCount += 1;

            // set the viewport size
            await page.setViewport({
                width: 800,
                height: 418,
                deviceScaleFactor: 1,
            });

            // tell the page to visit the url
            await page.goto(url.toString());
            const pageStartTime = Date.now();
            await this.waitForScreenshotReady(page);
            console.log('Page ready in ' + (Date.now() - pageStartTime) + 'ms');
            // take a screenshot and save it in the screenshots directory
            const imageBuf = await page.screenshot();
            // close the browser
            await page.close();
            console.log("Fresh screenshot time " + (Date.now() - startTime) + "ms");
            return imageBuf;
        });
    }

    // Waits for the custom event the page triggers to indicate that the map
    // layers are fully loaded and displayed and it's a good time to take a
    // screenshot.
    async waitForScreenshotReady(page, seconds) {
        seconds = seconds || 30;
        console.log("Waiting for screenshot ready");
        // Use race to implement a timeout.
        return Promise.race([
            page.evaluate(() => {
                console.log("in page.evaluate");
                return new Promise((resolve, reject) => {
                    // Check every 100 ms if the map object exists, and install a listener for the screenshot-ready event if it does.
                    // let numChecks = 0;
                    const interval = setInterval(() => {
                        // console.log("checking if map exists.");
                        if (map) {
                            clearInterval(interval);
                            console.log("Installing map screenshot-ready listener");
                            map.on('screenshot-ready', () => {
                                console.log("Screenshot ready event received");
                                resolve();
                            });
                        }
                        //  else {
                        //     numChecks += 1;
                        //     if (numChecks > 350) {
                        //         console.log("Giving up waiting for map to load");
                        //         clearInterval(interval);
                        //         reject("Timed out waiting for map to load");
                        //     }
                        // }
                    }, 100);
                });
            }),
            new Promise((resolve, reject) => setTimeout(reject, seconds * 1000))
        ]);
    }

}


const previewer = new Previewer();

app.get("/preview", async (req, res) => {
    const startTime = Date.now();
    // Get the "u" query param.
    const urlStr = req.query.u;
    console.log('Screenshotting ' + urlStr);
    const url = new URL(urlStr);
    // If the domain isn't gpsjam.org, reject it.`
    if (url.host !== 'gpsjam.org') {
        console.log('Nice try.');
        res.status(400).send('Nice try.');
    } else {
        const params = url.searchParams;
        // Since we're rendering using a (virtual) browser window that's much
        // smaller than the size most people are looking at (800x418), as a hack we
        // zoom out a bit to still kinda show the same general region.
        const zoom = parseFloat(params.get('z')) - 1.0;
        const lat = parseFloat(params.get('lat'));
        const lon = parseFloat(params.get('lon'));
        if (!lat || !lon || Number.isNaN(zoom)) {
            // Return a 404 if the query params are incomplete. The slackbot agent
            // always makes additional requests for mangled versions of the URL and
            // I don't know why, and we don't want to spend the resources to render
            // broken versions of the map.
            console.log('Incomplete query params.');
            res.status(404).send('Incomplete query params');
            return;
        }
        params.set('z', zoom.toString());
        params.set('screenshot', '');
        const imageBuf = await previewer.getPreview(url);
        console.log('Screenshot took ' + (Date.now() - startTime) + 'ms');
        res.setHeader('Content-Type', 'image/png');
        res.send(imageBuf);
    }
});

