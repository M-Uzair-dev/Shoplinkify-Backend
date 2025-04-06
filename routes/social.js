const express = require("express");
const router = express.Router();
const User = require("../models/User");
const Post = require("../models/Post");
const axios = require("axios");
const { URL } = require("url");
const cheerio = require("cheerio");
const { protect } = require("../middleware/auth");
const Click = require("../models/click");
const dayjs = require("dayjs");
const isoWeek = require("dayjs/plugin/isoWeek");
dayjs.extend(isoWeek); // Enables week-based calculations

// Add these utility functions at the top of the file after the imports
const CACHE_DURATION = 24 * 60 * 60 * 1000; // 24 hours in milliseconds
const imageCache = new Map();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const retryWithBackoff = async (fn, maxRetries = 3, initialDelay = 1000) => {
  let retries = 0;
  while (retries < maxRetries) {
    try {
      return await fn();
    } catch (error) {
      retries++;
      if (retries === maxRetries) throw error;
      const delay = initialDelay * Math.pow(2, retries - 1);
      await sleep(delay);
    }
  }
};

const verifyImageAccessibility = async (imageUrl, platform) => {
  try {
    await axios.head(imageUrl, {
      timeout: 5000,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36",
        Referer: `https://www.${platform}.com/`,
        Accept: "image/webp,image/apng,image/*,*/*;q=0.8",
      },
    });
    return true;
  } catch (error) {
    console.log(
      `Warning: ${platform} image may not be directly accessible:`,
      error.message
    );
    return false;
  }
};

const getCachedImage = (url) => {
  const cached = imageCache.get(url);
  if (cached && Date.now() - cached.timestamp < CACHE_DURATION) {
    return cached.imageUrl;
  }
  return null;
};

const setCachedImage = (url, imageUrl) => {
  imageCache.set(url, {
    imageUrl,
    timestamp: Date.now(),
  });
};

router.get("/clicks", protect, async (req, res) => {
  try {
    const clicks = await Click.find({ user: req.user._id });
    const result = {
      instagram: [],
      facebook: [],
      youtube: [],
      tiktok: [],
    };

    // Helper object to organize data before formatting
    const grouped = {
      instagram: {},
      facebook: {},
      youtube: {},
      tiktok: {},
    };

    // Group clicks by platform and then by week
    clicks.forEach((click) => {
      const { platform, date } = click;
      const weekStart = dayjs(date).startOf("isoWeek").format("YYYY-MM-DD");

      if (!grouped[platform]) grouped[platform] = {};
      if (!grouped[platform][weekStart]) grouped[platform][weekStart] = 0;

      grouped[platform][weekStart]++;
    });

    // Transform grouped data into desired array format
    Object.keys(grouped).forEach((platform) => {
      const weeks = grouped[platform];
      const weeklyClicks = [];

      Object.keys(weeks)
        .sort() // sort weeks chronologically
        .forEach((weekStart) => {
          weeklyClicks.push({
            weekStart,
            clicks: weeks[weekStart],
          });
        });

      result[platform] = weeklyClicks;
    });

    res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    console.error("Error organizing clicks:", error);
    res.status(500).json({
      success: false,
      message: "Server error while processing clicks",
    });
  }
});

router.get("/post/details", protect, async (req, res) => {
  try {
    const { url, platform } = req.query;

    if (!url || !platform) {
      return res.status(400).json({
        success: false,
        message: "URL and platform are required",
      });
    }

    // Validate platform
    const validPlatforms = ["youtube", "tiktok", "instagram", "facebook"];
    if (!validPlatforms.includes(platform)) {
      return res.status(400).json({
        success: false,
        message:
          "Invalid platform. Must be one of: youtube, tiktok, instagram, facebook",
      });
    }

    // Find the post
    const post = await Post.findOne({
      user: req.user._id,
      url,
      platform,
    }).lean();

    if (!post) {
      return res.status(404).json({
        success: false,
        message: "Post not found",
      });
    }

    await Click.create({
      user: req.user._id,
      post: post._id,
      country: req.query.country,
      platform: platform,
    });

    res.json({
      success: true,
      data: post,
    });
  } catch (error) {
    console.error("Error fetching post details:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching post details",
      error: error.message,
    });
  }
});

router.post("/youtube", protect, async (req, res) => {
  try {
    const { url } = req.body;

    if (!url) {
      return res.status(400).json({
        success: false,
        message: "YouTube URL is required in the request body",
      });
    }

    // Extract video ID from various YouTube URL formats
    let videoId = null;
    let normalizedUrl = url;

    // Check if it's an embed code
    if (url.includes("<iframe")) {
      const srcMatch = url.match(
        /src=["'](https?:\/\/www\.youtube\.com\/embed\/[^"'?&]+)["']/i
      );
      if (srcMatch && srcMatch[1]) {
        normalizedUrl = srcMatch[1];
        console.log("Extracted YouTube URL from embed code:", normalizedUrl);
      }
    }

    // Extract video ID based on URL format
    if (normalizedUrl.includes("youtube.com/watch?v=")) {
      // Standard YouTube URL: https://www.youtube.com/watch?v=VIDEO_ID
      const urlParams = new URLSearchParams(normalizedUrl.split("?")[1]);
      videoId = urlParams.get("v");
    } else if (normalizedUrl.includes("youtu.be/")) {
      // Shortened YouTube URL: https://youtu.be/VIDEO_ID
      videoId = normalizedUrl.split("youtu.be/")[1]?.split(/[?&]/)[0];
    } else if (normalizedUrl.includes("youtube.com/embed/")) {
      // Embed URL: https://www.youtube.com/embed/VIDEO_ID
      videoId = normalizedUrl.split("youtube.com/embed/")[1]?.split(/[?&/]/)[0];
    }

    if (!videoId) {
      return res.status(400).json({
        success: false,
        message: "Could not extract YouTube video ID from the provided URL",
      });
    }

    // Get YouTube API key from environment variables
    const apiKey = process.env.YOUTUBE_API_KEY;
    if (!apiKey) {
      return res.status(500).json({
        success: false,
        message: "YouTube API key is not configured",
      });
    }

    try {
      // Fetch video details
      const videoApiUrl = `https://www.googleapis.com/youtube/v3/videos?id=${videoId}&key=${apiKey}&part=snippet`;
      console.log("Fetching video details from:", videoApiUrl);
      const videoResponse = await axios.get(videoApiUrl);
      const videoData = videoResponse.data;

      if (!videoData.items || videoData.items.length === 0) {
        throw new Error("Could not fetch video metadata!");
      }

      const snippet = videoData.items[0].snippet;
      const channelId = snippet.channelId;
      const title = snippet.title;
      const thumbnailUrl = snippet.thumbnails.high.url;
      const channelName = snippet.channelTitle;

      // Fetch channel details (for channel image)
      const channelApiUrl = `https://www.googleapis.com/youtube/v3/channels?id=${channelId}&key=${apiKey}&part=snippet`;
      const channelResponse = await axios.get(channelApiUrl);
      const channelData = channelResponse.data;

      if (!channelData.items || channelData.items.length === 0) {
        throw new Error("Could not fetch channel data!");
      }

      const channelImage = channelData.items[0].snippet.thumbnails.default.url;

      // Create embed HTML
      const embedCode = `<iframe width="560" height="315" src="https://www.youtube.com/embed/${videoId}" frameborder="0" allowfullscreen></iframe>`;

      console.log("Successfully fetched YouTube data:", {
        videoId,
        title,
        thumbnailUrl,
        channelName,
        channelImage,
      });

      // Create new post using Post model
      const post = await Post.create({
        user: req.user._id,
        platform: "youtube",
        url: normalizedUrl,
        videoId: videoId,
        thumbnailUrl: thumbnailUrl,
        title: title,
        channelName: channelName,
        channelImage: channelImage,
        description: snippet.description || "",
        embedCode: embedCode,
      });

      return res.status(200).json({
        success: true,
        platform: "youtube",
        url: normalizedUrl,
        videoId: videoId,
        thumbnailUrl: thumbnailUrl,
        title: title,
        channelName: channelName,
        channelImage: channelImage,
        description: snippet.description || "",
        embedCode: embedCode,
        message: "YouTube video added successfully",
      });
    } catch (error) {
      console.error("YouTube API error:", error.message);
      if (error.response && error.response.data) {
        console.error(
          "YouTube API error details:",
          JSON.stringify(error.response.data, null, 2)
        );
      }
      return res.status(500).json({
        success: false,
        message: "Error fetching YouTube data",
        error: error.message,
      });
    }
  } catch (error) {
    console.error("YouTube processing error:", error);
    return res.status(500).json({
      success: false,
      message: "Error processing YouTube video",
      error: error.message,
    });
  }
});

router.post("/instagram", protect, async (req, res) => {
  try {
    const { url: postUrl, embedCode } = req.body;

    if (!postUrl) {
      return res.status(400).json({
        success: false,
        message: "Post URL is required in the request body",
      });
    }

    // Check if the URL itself is an embed code
    const isEmbedCode =
      postUrl.includes("<blockquote") && postUrl.includes("instagram-media");

    let processedUrl = postUrl;
    let originalEmbedCode = embedCode || null;

    // If URL is actually an embed code, extract the URL from it
    if (isEmbedCode) {
      originalEmbedCode = postUrl;
      const urlMatch = postUrl.match(
        /https:\/\/www\.instagram\.com\/p\/[^\/'"]+/
      );
      if (urlMatch) {
        processedUrl = urlMatch[0];
        console.log(
          "Extracted Instagram URL from embed code in URL field:",
          processedUrl
        );
      }
    }
    // If the separate embed code is provided and URL is not an embed code
    else if (
      embedCode &&
      embedCode.includes("<blockquote") &&
      embedCode.includes("instagram-media")
    ) {
      originalEmbedCode = embedCode;
      console.log("Using provided embed code");

      // Try to extract URL from embed code if URL looks invalid
      if (!processedUrl.includes("instagram.com")) {
        const urlMatch = embedCode.match(
          /https:\/\/www\.instagram\.com\/p\/[^\/'"]+/
        );
        if (urlMatch) {
          processedUrl = urlMatch[0];
          console.log(
            "Extracted Instagram URL from embed code field:",
            processedUrl
          );
        }
      }
    }

    const isEmbedUrl =
      processedUrl.includes("/embed") && processedUrl.includes("instagram.com");

    if (!isEmbedUrl && processedUrl.includes("instagram.com")) {
      const shortcodeMatch = processedUrl.match(/\/(p|reel|tv)\/([^\/\?]+)/);
      if (shortcodeMatch && shortcodeMatch[2]) {
        const shortcode = shortcodeMatch[2];

        processedUrl = `https://www.instagram.com/p/${shortcode}/embed/`;
        console.log("Converted to Instagram embed URL:", processedUrl);
      }
    }

    if (
      !/^https?:\/\/(www\.)?instagram\.com\/(p|reel|tv)\/[a-zA-Z0-9_-]+/.test(
        processedUrl
      )
    ) {
      return res.status(400).json({
        success: false,
        message: "Invalid Instagram URL. Must be a post, reel, or TV URL",
      });
    }

    try {
      console.log("Attempting to extract Instagram image from:", processedUrl);

      const { data } = await axios.get(processedUrl, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36",
          "Accept-Language": "en-US,en;q=0.9",
          Accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
          "Cache-Control": "no-cache",
          Pragma: "no-cache",
          "sec-ch-ua": '"Not?A_Brand";v="8", "Chromium";v="108"',
          "sec-ch-ua-mobile": "?0",
          "sec-ch-ua-platform": '"Windows"',
          "Sec-Fetch-Dest": "document",
          "Sec-Fetch-Mode": "navigate",
          "Sec-Fetch-Site": "none",
          "Sec-Fetch-User": "?1",
          Referer: "https://www.google.com/",
        },
        timeout: 15000,
        maxRedirects: 5,
      });

      console.log("Successfully fetched Instagram page HTML");

      let imageUrl = null;
      let extractionMethod = "";
      const $ = cheerio.load(data);

      if (processedUrl.includes("/embed")) {
        console.log("Processing as embed URL");

        const mainImage =
          $("img.EmbeddedAsset").attr("src") ||
          $("img._aa8j").attr("src") ||
          $("img.FFVAD").attr("src");

        if (mainImage) {
          imageUrl = mainImage;
          extractionMethod = "embed_main_image";
          console.log("Found image in embed main element");
        }

        if (!imageUrl) {
          const dataSrcImage = $("img[data-src]").attr("data-src");
          if (dataSrcImage) {
            imageUrl = dataSrcImage;
            extractionMethod = "embed_data_src";
            console.log("Found image in embed data-src attribute");
          }
        }
      }

      if (!imageUrl) {
        const dimensionsMatch = data.match(
          /"dimensions":\s*\{[^}]*"height":(\d+),"width":(\d+)[^}]*\}/
        );
        if (dimensionsMatch) {
          console.log(
            `Found image dimensions: ${dimensionsMatch[2]}×${dimensionsMatch[1]}`
          );

          const resourcesMatch = data.match(
            /"display_resources":\s*\[(.*?)\]/s
          );
          if (resourcesMatch && resourcesMatch[1]) {
            try {
              const jsonText = "[" + resourcesMatch[1] + "]";
              const resources = JSON.parse(jsonText);

              if (resources && resources.length > 0) {
                const sorted = resources.sort(
                  (a, b) =>
                    b.config_width * b.config_height -
                    a.config_width * a.config_height
                );

                if (sorted[0] && sorted[0].src) {
                  imageUrl = sorted[0].src;
                  extractionMethod = "display_resources";
                  console.log(
                    `Found uncropped image (${sorted[0].config_width}×${sorted[0].config_height})`
                  );
                }
              }
            } catch (e) {
              console.log("Error parsing display_resources:", e.message);
            }
          }
        }
      }

      if (!imageUrl) {
        console.log("Looking for srcset attributes");
        let largestSrcSetImage = null;
        let largestWidth = 0;

        $("img[srcset]").each((i, el) => {
          const srcset = $(el).attr("srcset");
          if (srcset) {
            const srcsetParts = srcset.split(",");
            for (const part of srcsetParts) {
              const [url, widthStr] = part.trim().split(" ");
              if (url && widthStr) {
                const width = parseInt(widthStr.replace("w", ""));
                if (width > largestWidth) {
                  largestWidth = width;
                  largestSrcSetImage = url;
                }
              }
            }
          }
        });

        if (largestSrcSetImage) {
          imageUrl = largestSrcSetImage;
          extractionMethod = "srcset_largest";
          console.log(`Found image in srcset (${largestWidth}w):`, imageUrl);
        }
      }

      if (!imageUrl) {
        const jsonLdMatch = data.match(
          /<script type="application\/ld\+json">(.*?)<\/script>/s
        );
        if (jsonLdMatch && jsonLdMatch[1]) {
          try {
            const jsonLD = JSON.parse(jsonLdMatch[1].trim());

            if (jsonLD.image) {
              if (Array.isArray(jsonLD.image)) {
                imageUrl = jsonLD.image[0];
                extractionMethod = "jsonLD_array";
              } else if (typeof jsonLD.image === "string") {
                imageUrl = jsonLD.image;
                extractionMethod = "jsonLD_string";
              }
            }
          } catch (e) {
            console.log("Error parsing JSON-LD:", e.message);
          }
        }
      }

      if (!imageUrl) {
        const displayUrlMatch = data.match(/"display_url":"([^"]+)"/);
        if (displayUrlMatch && displayUrlMatch[1]) {
          imageUrl = displayUrlMatch[1].replace(/\\/g, "");
          extractionMethod = "display_url";
          console.log("Found image in display_url");
        }
      }

      if (!imageUrl) {
        imageUrl = $('meta[property="og:image"]').attr("content");
        if (imageUrl) {
          extractionMethod = "og_image";
          console.log("Fallback to og:image meta tag");
        }
      }

      if (!imageUrl) {
        return res.status(404).json({
          success: false,
          message: "Could not find image for the Instagram post",
        });
      }

      if (imageUrl.startsWith("//")) {
        imageUrl = "https:" + imageUrl;
      }

      console.log("Original URL:", imageUrl);
      const originalUrl = imageUrl;

      imageUrl = imageUrl
        .replace(/\/s\d+x\d+\//, "/")
        .replace(/\/c\d+\.\d+\.\d+\.\d+\//, "/")
        .replace(/\/e\d+\//, "/")
        .replace(/\/[a-z]\d+x\d+\//, "/")
        .replace(/\/(vp|p|s)[0-9]+x[0-9]+(_[0-9]+)?\//, "/")
        .replace(/\/p[0-9]+x[0-9]+\//, "/")
        .replace(/[\?&]se=\d+/, "")
        .replace(/[\?&]sh=\d+/, "")
        .replace(/[\?&]sw=\d+/, "")
        .replace(/[\?&]quality=\d+/, "")
        .replace(/\?_nc_ht.*$/, "")
        .replace(/\?_nc_cat.*$/, "")
        .replace(/\?igshid.*$/, "")
        .replace(/\?_nc_.*$/, "");

      imageUrl = imageUrl
        .replace(/\\u0026/g, "&")
        .replace(/\\u003D/g, "=")
        .replace(/\\/g, "");

      if (originalUrl !== imageUrl) {
        console.log("Transformed URL to remove cropping:", imageUrl);
      }

      // Verify the image is accessible by making a HEAD request
      try {
        console.log("Verifying Instagram image accessibility:", imageUrl);
        await axios.head(imageUrl, {
          timeout: 5000,
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36",
            Referer: "https://www.instagram.com/",
          },
        });
        console.log("Instagram image is accessible");
      } catch (error) {
        console.log(
          "Warning: Instagram image may not be directly accessible:",
          error.message
        );
        // We'll still try to use it, but we'll note the warning
      }

      const originalPostUrl = isEmbedUrl
        ? processedUrl.replace("/embed/", "/")
        : processedUrl;

      // Create new post using Post model
      const post = await Post.create({
        user: req.user._id,
        platform: "instagram",
        url: postUrl,
        imageUrl: imageUrl,
        embedCode: originalEmbedCode,
        title: "",
        description: "",
      });

      return res.status(200).json({
        success: true,
        platform: "instagram",
        url: postUrl,
        imageUrl: imageUrl,
        extractionMethod: extractionMethod,
        message: "Instagram post image added successfully",
      });
    } catch (error) {
      console.error("Instagram scraping error:", error);
      return res.status(404).json({
        success: false,
        message:
          "Error accessing Instagram post. It may be private or not publicly accessible.",
        error: error.message,
      });
    }
  } catch (error) {
    console.error("Instagram API error:", error);
    return res.status(500).json({
      success: false,
      message: "Error fetching Instagram image",
      error: error.message,
    });
  }
});

// Helper function to extract Facebook image URL
const extractFacebookImageUrl = async (url) => {
  try {
    console.log("Extracting Facebook image from URL:", url);

    // First try to get the image from the Open Graph meta tags
    const response = await axios({
      method: "get",
      url: url,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Cache-Control": "no-cache",
        Pragma: "no-cache",
        DNT: "1",
        Connection: "keep-alive",
        "Upgrade-Insecure-Requests": "1",
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "none",
        "Sec-Fetch-User": "?1",
      },
      timeout: 10000,
      maxRedirects: 5,
    });

    const html = response.data;

    // Try to extract image from Open Graph meta tags
    const ogImageMatch = html.match(
      /<meta[^>]*property="og:image"[^>]*content="([^"]*)"[^>]*>/i
    );
    if (ogImageMatch && ogImageMatch[1]) {
      console.log("Found Facebook image from OG meta tag:", ogImageMatch[1]);
      return ogImageMatch[1];
    }

    // Try to extract image from Twitter card meta tags
    const twitterImageMatch = html.match(
      /<meta[^>]*name="twitter:image"[^>]*content="([^"]*)"[^>]*>/i
    );
    if (twitterImageMatch && twitterImageMatch[1]) {
      console.log(
        "Found Facebook image from Twitter meta tag:",
        twitterImageMatch[1]
      );
      return twitterImageMatch[1];
    }

    // Try to extract image from structured data
    const structuredDataMatch = html.match(/"image":\s*"([^"]+)"/i);
    if (structuredDataMatch && structuredDataMatch[1]) {
      console.log(
        "Found Facebook image from structured data:",
        structuredDataMatch[1]
      );
      return structuredDataMatch[1];
    }

    // Try to extract image from img tags with specific classes or IDs
    const imgTagMatches =
      html.match(
        /<img[^>]*class="[^"]*scaledImage[^"]*"[^>]*src="([^"]*)"[^>]*>/i
      ) ||
      html.match(/<img[^>]*id="[^"]*fbImage[^"]*"[^>]*src="([^"]*)"[^>]*>/i) ||
      html.match(/<img[^>]*data-src="([^"]*)"[^>]*>/i);

    if (imgTagMatches && imgTagMatches[1]) {
      console.log("Found Facebook image from img tag:", imgTagMatches[1]);
      return imgTagMatches[1];
    }

    // If all else fails, try to extract any image URL from the page
    const anyImageMatch = html.match(
      /https:\/\/[^"']*\.(?:jpg|jpeg|png|gif|webp)[^"']*/i
    );
    if (anyImageMatch) {
      console.log(
        "Found Facebook image from general pattern:",
        anyImageMatch[0]
      );
      return anyImageMatch[0];
    }

    console.log("No Facebook image found in the page");
    return null;
  } catch (error) {
    console.error("Error extracting Facebook image:", error.message);
    return null;
  }
};

// Update the Facebook post route
router.post("/facebook", protect, async (req, res) => {
  try {
    const { url } = req.body;

    if (!url) {
      return res.status(400).json({
        success: false,
        message: "URL is required",
      });
    }

    // Validate URL format
    if (!url.includes("facebook.com")) {
      return res.status(400).json({
        success: false,
        message: "Invalid Facebook URL",
      });
    }

    // Check if post already exists
    const existingPost = await Post.findOne({
      userId: req.user._id,
      url: url,
      platform: "facebook",
    });

    if (existingPost) {
      return res.status(400).json({
        success: false,
        message: "This Facebook post has already been added",
      });
    }

    // Extract image URL
    let imageUrl = null;
    try {
      imageUrl = await extractFacebookImageUrl(url);
      console.log("Extracted Facebook image URL:", imageUrl);
    } catch (error) {
      console.error("Error extracting Facebook image:", error);
      // Continue without image
    }

    // Create new post
    const newPost = new Post({
      userId: req.user._id,
      platform: "facebook",
      url: url,
      imageUrl: imageUrl,
      addedAt: new Date(),
    });

    await newPost.save();

    return res.status(201).json({
      success: true,
      message: "Facebook post added successfully",
      post: newPost,
    });
  } catch (error) {
    console.error("Error adding Facebook post:", error);
    return res.status(500).json({
      success: false,
      message: "Error adding Facebook post",
      error: error.message,
    });
  }
});

// TikTok video details endpoint
router.post("/tiktok", protect, async (req, res) => {
  try {
    const { url: videoUrl } = req.body;

    if (!videoUrl) {
      return res.status(400).json({
        success: false,
        message: "Video URL is required in the request body",
      });
    }

    console.log("Processing TikTok URL:", videoUrl);

    // Validate the URL format
    if (!videoUrl.includes("tiktok.com")) {
      return res.status(400).json({
        success: false,
        message: "Invalid TikTok URL. Must be a TikTok video URL",
      });
    }

    try {
      // Use exactly the same API endpoint and approach as the working HTML example
      console.log(
        "Fetching TikTok metadata via TikWm API using simplified approach"
      );
      const tikwmUrl = `https://www.tikwm.com/api/?url=${encodeURIComponent(
        videoUrl
      )}`;

      // Make a simple request without excessive headers
      const response = await axios.get(tikwmUrl);
      console.log(
        "TikWm API response received:",
        JSON.stringify(response.data).substring(0, 500)
      );

      // Simple validation matching the HTML example
      if (response.data && response.data.data) {
        const thumbnailUrl = response.data.data.origin_cover || "";
        const caption = response.data.data.title || "";
        const videoId = response.data.data.id || "";
        const username = response.data.data.author?.unique_id || "";
        const userImage = response.data.data.author?.avatar || "";
        const videoPath = response.data.data.wmplay || "";

        console.log("Successfully extracted TikTok data:", {
          thumbnailUrl,
          caption,
          username,
          userImage,
          videoPath,
        });

        // Create new post using Post model
        const post = await Post.create({
          user: req.user._id,
          platform: "tiktok",
          url: videoUrl,
          thumbnailUrl: thumbnailUrl,
          caption: caption,
          videoId: videoId,
          username: username,
          userImage: userImage,
          videoPath: videoPath,
          title: caption || "",
          description: "",
        });

        return res.status(200).json({
          success: true,
          platform: "tiktok",
          url: videoUrl,
          thumbnailUrl: thumbnailUrl,
          title: caption,
          videoId: videoId,
          username: username,
          userImage: userImage,
          videoPath: videoPath,
          extractionMethod: "tikwm_api_simplified",
          message: "TikTok video added successfully",
        });
      } else {
        throw new Error("Invalid response format from TikWm API");
      }
    } catch (error) {
      console.error("TikTok API error:", error);

      // Fallback to Open Graph method
      try {
        console.log(
          "Trying alternative TikTok metadata extraction method (Open Graph)"
        );

        // Fetch the TikTok page directly
        const { data: tiktokPageData } = await axios.get(videoUrl, {
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
          },
          timeout: 10000,
        });

        // Try to extract thumbnail from Open Graph meta tags
        const $ = cheerio.load(tiktokPageData);
        let thumbnailUrl = $('meta[property="og:image"]').attr("content");
        let caption =
          $('meta[property="og:description"]').attr("content") || "";

        if (thumbnailUrl) {
          console.log(
            "Successfully extracted thumbnail via Open Graph tags:",
            thumbnailUrl
          );

          // Create new post using Post model
          const post = await Post.create({
            user: req.user._id,
            platform: "tiktok",
            url: videoUrl,
            thumbnailUrl: thumbnailUrl,
            caption: caption,
          });

          return res.status(200).json({
            success: true,
            platform: "tiktok",
            url: videoUrl,
            thumbnailUrl: thumbnailUrl,
            caption: caption,
            extractionMethod: "opengraph",
            message: "TikTok video added successfully with OG tags",
          });
        }
      } catch (alternativeError) {
        console.error(
          "Alternative TikTok extraction method failed:",
          alternativeError
        );
      }

      // Fallback to logo if all else fails
      const fallbackThumbnail =
        "https://sf16-sg.tiktokcdn.com/obj/eden-sg/uvkuhyieh7lpqegw/tiktok_logo.png";

      // Create new post using Post model with fallback image
      const post = await Post.create({
        user: req.user._id,
        platform: "tiktok",
        url: videoUrl,
        thumbnailUrl: fallbackThumbnail,
      });

      // We still return success, just with the fallback image
      return res.status(200).json({
        success: true,
        platform: "tiktok",
        url: videoUrl,
        thumbnailUrl: fallbackThumbnail,
        extractionMethod: "fallback_logo",
        message: "TikTok video added with fallback image",
      });
    }
  } catch (error) {
    console.error("TikTok processing error:", error);
    return res.status(500).json({
      success: false,
      message: "Error processing TikTok video",
      error: error.message,
    });
  }
});

// Delete a social media post
router.delete("/delete", protect, async (req, res) => {
  try {
    const { url, platform } = req.body;

    if (!url || !platform) {
      return res.status(400).json({
        success: false,
        message: "URL and platform are required in the request body",
      });
    }

    if (!["youtube", "tiktok", "instagram", "facebook"].includes(platform)) {
      return res.status(400).json({
        success: false,
        message:
          "Invalid platform. Must be youtube, tiktok, instagram, or facebook",
      });
    }

    const user = req.user;
    let deleted = false;

    switch (platform) {
      case "youtube":
        {
          const postIndex = user.youtubePosts.findIndex(
            (post) => post.url === url
          );
          if (postIndex !== -1) {
            user.youtubePosts.splice(postIndex, 1);
            deleted = true;
          } else {
            const legacyIndex = user.youtubeEmbeds.indexOf(url);
            if (legacyIndex !== -1) {
              user.youtubeEmbeds.splice(legacyIndex, 1);
              deleted = true;
            }
          }
        }
        break;

      case "tiktok":
        {
          const postIndex = user.tiktokPosts.findIndex(
            (post) => post.url === url
          );
          if (postIndex !== -1) {
            user.tiktokPosts.splice(postIndex, 1);
            deleted = true;
          } else {
            const legacyIndex = user.tiktokEmbeds.indexOf(url);
            if (legacyIndex !== -1) {
              user.tiktokEmbeds.splice(legacyIndex, 1);
              deleted = true;
            }
          }
        }
        break;

      case "instagram":
        {
          const postIndex = user.instagramPosts.findIndex(
            (post) => post.url === url
          );
          if (postIndex !== -1) {
            user.instagramPosts.splice(postIndex, 1);
            deleted = true;
          } else {
            const legacyIndex = user.instagramPosts.indexOf(url);
            if (legacyIndex !== -1) {
              user.instagramPosts.splice(legacyIndex, 1);
              deleted = true;
            }
          }
        }
        break;

      case "facebook":
        {
          const postIndex = user.facebookPosts.findIndex(
            (post) => post.url === url
          );
          if (postIndex !== -1) {
            user.facebookPosts.splice(postIndex, 1);
            deleted = true;
          } else {
            const legacyIndex = user.facebookPosts.indexOf(url);
            if (legacyIndex !== -1) {
              user.facebookPosts.splice(legacyIndex, 1);
              deleted = true;
            }
          }
        }
        break;
    }

    await user.save();

    if (deleted) {
      return res.status(200).json({
        success: true,
        message: `${platform} post deleted successfully`,
      });
    } else {
      return res.status(404).json({
        success: false,
        message: `${platform} post not found with the provided URL`,
      });
    }
  } catch (error) {
    console.error("Delete post error:", error);
    return res.status(500).json({
      success: false,
      message: "Error deleting post",
      error: error.message,
    });
  }
});

// Get feed settings - moved before the /:platform route to avoid conflict
router.get("/feed/settings", protect, async (req, res) => {
  try {
    const user = req.user;

    // If user doesn't have feedSettings yet, return defaults
    const feedSettings = user.feedSettings || {
      layout: "Grid",
      postsCount: "6",
    };

    return res.status(200).json({
      success: true,
      feedSettings: feedSettings,
    });
  } catch (error) {
    console.error("Error fetching feed settings:", error);
    return res.status(500).json({
      success: false,
      message: "Error fetching feed settings",
      error: error.message,
    });
  }
});

// Update feed settings - moved before the /:platform route to avoid conflict
router.post("/feed/settings", protect, async (req, res) => {
  try {
    const user = req.user;
    const { setting, value } = req.body;

    if (!setting || !value) {
      return res.status(400).json({
        success: false,
        message: "Setting name and value are required",
      });
    }

    // Check if setting is valid
    if (!["layout", "postsCount"].includes(setting)) {
      return res.status(400).json({
        success: false,
        message: "Invalid setting. Must be one of: layout, postsCount",
      });
    }

    // Validate value based on setting
    if (
      setting === "layout" &&
      ![
        "Grid",
        "No Gutter",
        "Highlight",
        "Slideshow",
        "Collage1",
        "Collage2",
        "Collage3",
        "Collage4",
        "Collage5",
      ].includes(value)
    ) {
      return res.status(400).json({
        success: false,
        message: "Invalid layout. Must be one of: Grid, Carousel, Masonry",
      });
    }

    if (
      setting === "postsCount" &&
      !["3", "6", "9", "12", "15"].includes(value)
    ) {
      return res.status(400).json({
        success: false,
        message: "Invalid postsCount. Must be one of: 3, 6, 9, 12, 15",
      });
    }

    // Initialize feedSettings if it doesn't exist
    if (!user.feedSettings) {
      user.feedSettings = {
        layout: "Grid",
        postsCount: "6",
      };
    }

    // Update the setting
    user.feedSettings[setting] = value;

    // Save the updated user
    await user.save();

    return res.status(200).json({
      success: true,
      message: `Feed ${setting} updated successfully`,
      feedSettings: user.feedSettings,
    });
  } catch (error) {
    console.error("Error updating feed settings:", error);
    return res.status(500).json({
      success: false,
      message: "Server error",
      error: error.message,
    });
  }
});

// Get platforms - moved before the /:platform route to avoid conflict
router.get("/getplatforms", protect, async (req, res) => {
  try {
    const user = req.user;
    const platforms = user.selectedPlatforms;
    return res.status(200).json({
      success: true,
      platforms: platforms,
    });
  } catch (error) {
    console.error("Error fetching platforms:", error);
    return res.status(500).json({
      success: false,
      message: "Error fetching platforms",
      error: error.message,
    });
  }
});

// Toggle platform - moved before the /:platform route to avoid conflict
router.post("/platforms/toggle", protect, async (req, res) => {
  try {
    const user = req.user;
    const { platform } = req.body;

    if (!platform) {
      return res.status(400).json({
        success: false,
        message: "Platform name is required",
      });
    }

    // Check if platform is valid
    const validPlatforms = ["instagram", "facebook", "youtube", "tiktok"];
    if (!validPlatforms.includes(platform)) {
      return res.status(400).json({
        success: false,
        message:
          "Invalid platform. Must be one of: instagram, facebook, youtube, tiktok",
      });
    }

    // Toggle the platform value
    const currentValue = user.selectedPlatforms[platform] || false;
    user.selectedPlatforms[platform] = !currentValue;

    // Save the updated user
    await user.save();
    console.log(user.selectedPlatforms);

    return res.status(200).json({
      success: true,
      message: `${platform} toggled successfully`,
      status: user.selectedPlatforms[platform],
    });
  } catch (error) {
    console.error("Error toggling platform:", error);
    return res.status(500).json({
      success: false,
      message: "Server error",
      error: error.message,
    });
  }
});

// Get posts by platform
router.get("/:platform", protect, async (req, res) => {
  try {
    const { platform } = req.params;

    // Validate platform
    const validPlatforms = ["youtube", "tiktok", "instagram", "facebook"];
    if (!validPlatforms.includes(platform)) {
      return res.status(400).json({
        success: false,
        message:
          "Invalid platform. Must be one of: youtube, tiktok, instagram, facebook",
      });
    }

    const posts = await Post.find({
      user: req.user._id,
      platform,
    })
      .sort({ addedAt: -1 })
      .lean();

    res.json({
      success: true,
      data: posts,
    });
  } catch (error) {
    console.error("Error fetching posts:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching posts",
      error: error.message,
    });
  }
});

// Get all posts for a user
router.get("/posts/all", protect, async (req, res) => {
  try {
    const user = req.user;
    const { selectedPlatforms, feedSettings } = user;
    const postsCount = parseInt(feedSettings?.postsCount || "6");

    let platforms = [];
    if (selectedPlatforms.instagram) platforms.push("instagram");
    if (selectedPlatforms.facebook) platforms.push("facebook");
    if (selectedPlatforms.youtube) platforms.push("youtube");
    if (selectedPlatforms.tiktok) platforms.push("tiktok");

    // Get posts for each selected platform
    const posts = await Post.find({
      user: req.user._id,
      platform: {
        $in: platforms,
      },
      selected: true,
    })
      .sort({ addedAt: -1 })
      .limit(postsCount)
      .select("imageUrl url platform thumbnailUrl")
      .lean();

    // Map posts to consistent format and use proxy for TikTok images
    const formattedPosts = posts.map((post) => {
      let imageUrl = post.thumbnailUrl || post.imageUrl;

      return {
        imageUrl,
        url: post.url,
        platform: post.platform,
      };
    });

    console.log(posts);

    res.json({
      success: true,
      posts: formattedPosts,
    });
  } catch (error) {
    console.error("Error fetching posts:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching posts",
      error: error.message,
    });
  }
});

// Delete a post
router.delete("/post/:postId", protect, async (req, res) => {
  try {
    const { postId } = req.params;

    if (!postId) {
      return res.status(400).json({
        success: false,
        message: "Post ID is required",
      });
    }

    // Find and delete the post, ensuring it belongs to the user
    const deletedPost = await Post.findOneAndDelete({
      _id: postId,
      user: req.user._id,
    });

    if (!deletedPost) {
      return res.status(404).json({
        success: false,
        message: "Post not found or unauthorized",
      });
    }

    res.json({
      success: true,
      message: "Post deleted successfully",
    });
  } catch (error) {
    console.error("Error deleting post:", error);
    res.status(500).json({
      success: false,
      message: "Error deleting post",
      error: error.message,
    });
  }
});

// Update post selected status
router.post("/select", protect, async (req, res) => {
  try {
    console.log(req.body);
    const { postId } = req.body;

    // Find and update the post
    const post = await Post.findByIdAndUpdate(
      postId,
      {
        selected: true,
      },
      {
        new: true,
      }
    );

    if (!post) {
      return res.status(404).json({
        success: false,
        message: "Post not found",
      });
    }

    res.json({
      success: true,
      message: "Post updated successfully",
      data: post,
    });
  } catch (error) {
    console.error("Error updating post:", error);
    res.status(500).json({
      success: false,
      message: "Error updating post",
      error: error.message,
    });
  }
});

// Get selected posts
router.get("/selected-posts", protect, async (req, res) => {
  try {
    const posts = await Post.find({
      user: req.user._id,
      selected: true,
    })
      .sort({ addedAt: -1 })
      .lean();

    // Group posts by platform
    const groupedPosts = posts.reduce((acc, post) => {
      if (!acc[post.platform]) {
        acc[post.platform] = [];
      }
      acc[post.platform].push(post);
      return acc;
    }, {});

    res.json({
      success: true,
      data: groupedPosts,
    });
  } catch (error) {
    console.error("Error fetching selected posts:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching selected posts",
      error: error.message,
    });
  }
});

// Update post product link
router.patch("/post/product-link", protect, async (req, res) => {
  try {
    const { url, platform, productLink } = req.body;

    if (!url || !platform || !productLink) {
      return res.status(400).json({
        success: false,
        message: "URL, platform, and product link are required",
      });
    }

    // Find and update the post
    const post = await Post.findOneAndUpdate(
      {
        user: req.user._id,
        url,
        platform,
      },
      {
        productLink,
      },
      {
        new: true,
      }
    );

    if (!post) {
      return res.status(404).json({
        success: false,
        message: "Post not found",
      });
    }

    res.json({
      success: true,
      message: "Product link updated successfully",
      data: post,
    });
  } catch (error) {
    console.error("Error updating product link:", error);
    res.status(500).json({
      success: false,
      message: "Error updating product link",
      error: error.message,
    });
  }
});

// Get posts with product links
router.get("/posts-with-products", protect, async (req, res) => {
  try {
    const posts = await Post.find({
      user: req.user._id,
      productLink: { $exists: true, $ne: "" },
    })
      .sort({ addedAt: -1 })
      .lean();

    // Group posts by platform
    const groupedPosts = posts.reduce((acc, post) => {
      if (!acc[post.platform]) {
        acc[post.platform] = [];
      }
      acc[post.platform].push(post);
      return acc;
    }, {});

    res.json({
      success: true,
      data: groupedPosts,
    });
  } catch (error) {
    console.error("Error fetching posts with products:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching posts with products",
      error: error.message,
    });
  }
});

// Get posts by date range
router.get("/posts-by-date", protect, async (req, res) => {
  try {
    const { startDate, endDate } = req.query;

    if (!startDate || !endDate) {
      return res.status(400).json({
        success: false,
        message: "Start date and end date are required",
      });
    }

    const start = new Date(startDate);
    const end = new Date(endDate);

    if (isNaN(start.getTime()) || isNaN(end.getTime())) {
      return res.status(400).json({
        success: false,
        message: "Invalid date format",
      });
    }

    const posts = await Post.find({
      user: req.user._id,
      addedAt: {
        $gte: start,
        $lte: end,
      },
    })
      .sort({ addedAt: -1 })
      .lean();

    // Group posts by platform
    const groupedPosts = posts.reduce((acc, post) => {
      if (!acc[post.platform]) {
        acc[post.platform] = [];
      }
      acc[post.platform].push(post);
      return acc;
    }, {});

    res.json({
      success: true,
      data: groupedPosts,
    });
  } catch (error) {
    console.error("Error fetching posts by date range:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching posts by date range",
      error: error.message,
    });
  }
});

// Get posts by search term
router.get("/posts/search", protect, async (req, res) => {
  try {
    const { searchTerm } = req.query;

    if (!searchTerm) {
      return res.status(400).json({
        success: false,
        message: "Search term is required",
      });
    }

    const posts = await Post.find({
      user: req.user._id,
      $or: [
        { title: { $regex: searchTerm, $options: "i" } },
        { description: { $regex: searchTerm, $options: "i" } },
        { caption: { $regex: searchTerm, $options: "i" } },
      ],
    })
      .sort({ addedAt: -1 })
      .lean();

    // Group posts by platform
    const groupedPosts = posts.reduce((acc, post) => {
      if (!acc[post.platform]) {
        acc[post.platform] = [];
      }
      acc[post.platform].push(post);
      return acc;
    }, {});

    res.json({
      success: true,
      data: groupedPosts,
    });
  } catch (error) {
    console.error("Error searching posts:", error);
    res.status(500).json({
      success: false,
      message: "Error searching posts",
      error: error.message,
    });
  }
});

// Get posts by platform and date range
router.get("/posts/:platform/by-date", protect, async (req, res) => {
  try {
    const { platform } = req.params;
    const { startDate, endDate } = req.query;

    // Validate platform
    const validPlatforms = ["youtube", "tiktok", "instagram", "facebook"];
    if (!validPlatforms.includes(platform)) {
      return res.status(400).json({
        success: false,
        message:
          "Invalid platform. Must be one of: youtube, tiktok, instagram, facebook",
      });
    }

    if (!startDate || !endDate) {
      return res.status(400).json({
        success: false,
        message: "Start date and end date are required",
      });
    }

    const start = new Date(startDate);
    const end = new Date(endDate);

    if (isNaN(start.getTime()) || isNaN(end.getTime())) {
      return res.status(400).json({
        success: false,
        message: "Invalid date format",
      });
    }

    const posts = await Post.find({
      user: req.user._id,
      platform,
      addedAt: {
        $gte: start,
        $lte: end,
      },
    })
      .sort({ addedAt: -1 })
      .lean();

    res.json({
      success: true,
      data: posts,
    });
  } catch (error) {
    console.error("Error fetching posts by platform and date range:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching posts by platform and date range",
      error: error.message,
    });
  }
});

// Get posts by platform and search term
router.get("/posts/:platform/search", protect, async (req, res) => {
  try {
    const { platform } = req.params;
    const { searchTerm } = req.query;

    // Validate platform
    const validPlatforms = ["youtube", "tiktok", "instagram", "facebook"];
    if (!validPlatforms.includes(platform)) {
      return res.status(400).json({
        success: false,
        message:
          "Invalid platform. Must be one of: youtube, tiktok, instagram, facebook",
      });
    }

    if (!searchTerm) {
      return res.status(400).json({
        success: false,
        message: "Search term is required",
      });
    }

    const posts = await Post.find({
      user: req.user._id,
      platform,
      $or: [
        { title: { $regex: searchTerm, $options: "i" } },
        { description: { $regex: searchTerm, $options: "i" } },
        { caption: { $regex: searchTerm, $options: "i" } },
      ],
    })
      .sort({ addedAt: -1 })
      .lean();

    res.json({
      success: true,
      data: posts,
    });
  } catch (error) {
    console.error("Error searching posts by platform:", error);
    res.status(500).json({
      success: false,
      message: "Error searching posts by platform",
      error: error.message,
    });
  }
});

// Get posts by platform and product link
router.get("/posts/:platform/with-products", protect, async (req, res) => {
  try {
    const { platform } = req.params;

    // Validate platform
    const validPlatforms = ["youtube", "tiktok", "instagram", "facebook"];
    if (!validPlatforms.includes(platform)) {
      return res.status(400).json({
        success: false,
        message:
          "Invalid platform. Must be one of: youtube, tiktok, instagram, facebook",
      });
    }

    const posts = await Post.find({
      user: req.user._id,
      platform,
      productLink: { $exists: true, $ne: "" },
    })
      .sort({ addedAt: -1 })
      .lean();

    res.json({
      success: true,
      data: posts,
    });
  } catch (error) {
    console.error("Error fetching posts with products by platform:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching posts with products by platform",
      error: error.message,
    });
  }
});

// Get posts by platform and selected status
router.get("/posts/:platform/selected", protect, async (req, res) => {
  try {
    const { platform } = req.params;

    // Validate platform
    const validPlatforms = ["youtube", "tiktok", "instagram", "facebook"];
    if (!validPlatforms.includes(platform)) {
      return res.status(400).json({
        success: false,
        message:
          "Invalid platform. Must be one of: youtube, tiktok, instagram, facebook",
      });
    }

    const posts = await Post.find({
      user: req.user._id,
      platform,
      selected: true,
    })
      .sort({ addedAt: -1 })
      .lean();

    res.json({
      success: true,
      data: posts,
    });
  } catch (error) {
    console.error("Error fetching selected posts by platform:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching selected posts by platform",
      error: error.message,
    });
  }
});

// Deselect a post
router.post("/deselect", protect, async (req, res) => {
  try {
    const { postId } = req.body;

    if (!postId) {
      return res.status(400).json({
        success: false,
        message: "Post ID is required",
      });
    }

    // Find and update the post, ensuring it belongs to the user
    const updatedPost = await Post.findOneAndUpdate(
      {
        _id: postId,
        user: req.user._id,
      },
      {
        selected: false,
      },
      { new: true }
    );

    if (!updatedPost) {
      return res.status(404).json({
        success: false,
        message: "Post not found or unauthorized",
      });
    }

    res.json({
      success: true,
      message: "Post deselected successfully",
    });
  } catch (error) {
    console.error("Error deselecting post:", error);
    res.status(500).json({
      success: false,
      message: "Error deselecting post",
      error: error.message,
    });
  }
});

// Image proxy endpoint to bypass CORS restrictions
router.get("/proxy/image", async (req, res) => {
  try {
    const { url } = req.query;

    if (!url) {
      return res.status(400).json({
        success: false,
        message: "Image URL is required",
      });
    }

    console.log("Proxying image:", url);

    // Check cache first
    const cachedImageUrl = getCachedImage(url);
    if (cachedImageUrl) {
      console.log("Using cached image:", cachedImageUrl);
      return res.redirect(cachedImageUrl);
    }

    // Determine the appropriate referer based on the URL
    let referer = "https://www.google.com/";
    if (url.includes("instagram.com")) {
      referer = "https://www.instagram.com/";
    } else if (url.includes("facebook.com") || url.includes("fbcdn.net")) {
      referer = "https://www.facebook.com/";
    } else if (url.includes("tiktok.com")) {
      referer = "https://www.tiktok.com/";
    }

    // Enhanced request with better headers and error handling
    const response = await axios({
      method: "get",
      url: url,
      responseType: "arraybuffer",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
        Referer: referer,
        Accept: "image/webp,image/apng,image/*,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Cache-Control": "no-cache",
        Pragma: "no-cache",
        DNT: "1",
        Connection: "keep-alive",
        "Upgrade-Insecure-Requests": "1",
        "Sec-Fetch-Dest": "image",
        "Sec-Fetch-Mode": "no-cors",
        "Sec-Fetch-Site": "cross-site",
      },
      // Set longer timeout for large images
      timeout: 15000,
      maxRedirects: 5,
      validateStatus: function (status) {
        return status >= 200 && status < 400; // Accept 2xx and 3xx status codes
      },
    });

    // Set appropriate headers
    const contentType = response.headers["content-type"] || "image/jpeg";
    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "public, max-age=86400"); // Cache for a day
    res.setHeader("Access-Control-Allow-Origin", "*"); // Allow cross-origin access

    // Cache the successful image URL
    setCachedImage(url, url);

    // Send the image data
    res.send(response.data);
  } catch (error) {
    console.error("Image proxy error:", error.message);

    // Try alternative method for Instagram images
    if (
      error.response &&
      (error.response.status === 403 || error.response.status === 401)
    ) {
      try {
        const { url } = req.query;
        if (url.includes("instagram.com")) {
          // Try with a different approach for Instagram
          const response = await axios({
            method: "get",
            url: url,
            responseType: "arraybuffer",
            headers: {
              "User-Agent":
                "Mozilla/5.0 (iPhone; CPU iPhone OS 14_7_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.1.2 Mobile/15E148 Safari/604.1",
              Accept: "image/webp,image/apng,image/*,*/*;q=0.8",
              "Accept-Language": "en-US,en;q=0.9",
            },
            timeout: 10000,
          });

          res.setHeader(
            "Content-Type",
            response.headers["content-type"] || "image/jpeg"
          );
          res.setHeader("Cache-Control", "public, max-age=86400");
          res.setHeader("Access-Control-Allow-Origin", "*");

          return res.send(response.data);
        }
      } catch (fallbackError) {
        console.error("Fallback image proxy error:", fallbackError.message);
      }
    }

    // If the error is related to the image not being found, return a 404
    if (error.response && error.response.status === 404) {
      return res.status(404).json({
        success: false,
        message: "Image not found",
        error: error.message,
      });
    }

    // Return a fallback image based on the platform
    const url = req.query.url || "";
    let fallbackImage = null;

    if (url.includes("instagram.com")) {
      fallbackImage =
        "https://www.instagram.com/static/images/ico/favicon-192.png/68d99ba29cc8.png";
    } else if (url.includes("facebook.com") || url.includes("fbcdn.net")) {
      fallbackImage =
        "https://static.xx.fbcdn.net/rsrc.php/v3/y4/r/-PAXP-deijE.gif";
    } else if (url.includes("tiktok.com")) {
      fallbackImage =
        "https://sf16-sg.tiktokcdn.com/obj/eden-sg/uvkuhyieh7lpqegw/tiktok_logo.png";
    } else {
      fallbackImage =
        "https://via.placeholder.com/300x300?text=Image+Not+Available";
    }

    return res.redirect(fallbackImage);
  }
});

module.exports = router;
