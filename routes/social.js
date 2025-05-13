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
const uploadFile = require("../utils/uploadFile");
const fs = require("fs");
const path = require("path");
const { promisify } = require("util");
const stream = require("stream");
const pipeline = promisify(stream.pipeline);
const cloudinary = require("cloudinary").v2;
// ... existing code ...
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

    const grouped = {
      instagram: {},
      facebook: {},
      youtube: {},
      tiktok: {},
    };

    // Initialize counters
    const totalData = {
      instaTotal: 0,
      fbTotal: 0,
      ytTotal: 0,
      tikTotal: 0,
    };

    const clicksData = {
      desktopClicks: 0,
      phoneClicks: 0,
    };

    const countryData = {};

    // Process each click
    clicks.forEach((click) => {
      const { platform, date, device, country } = click;
      const weekStart = dayjs(date).startOf("isoWeek").format("YYYY-MM-DD");

      // Weekly grouping
      if (!grouped[platform]) grouped[platform] = {};
      if (!grouped[platform][weekStart]) grouped[platform][weekStart] = 0;
      grouped[platform][weekStart]++;

      // Total counts
      if (platform === "instagram") totalData.instaTotal++;
      if (platform === "facebook") totalData.fbTotal++;
      if (platform === "youtube") totalData.ytTotal++;
      if (platform === "tiktok") totalData.tikTotal++;

      // Device stats
      if (device === "mobile") clicksData.phoneClicks++;
      else clicksData.desktopClicks++;

      // Country stats
      if (country) {
        if (!countryData[country]) countryData[country] = 0;
        countryData[country]++;
      }
    });

    // Convert weekly grouped data into arrays
    Object.keys(grouped).forEach((platform) => {
      const weeks = grouped[platform];
      const weeklyClicks = [];

      Object.keys(weeks)
        .sort()
        .forEach((weekStart) => {
          weeklyClicks.push({
            weekStart,
            clicks: weeks[weekStart],
          });
        });

      result[platform] = weeklyClicks;
    });

    const clicksDataPercentage = {
      desktopClicks:
        (clicksData.desktopClicks /
          (clicksData.desktopClicks + clicksData.phoneClicks)) *
        100,
      phoneClicks:
        (clicksData.phoneClicks /
          (clicksData.desktopClicks + clicksData.phoneClicks)) *
        100,
    };
    res.json({
      success: true,
      data: result,
      totalData,
      clicksData: clicksDataPercentage,
      countryData,
    });
  } catch (error) {
    console.error("Error organizing clicks:", error);
    res.status(500).json({
      success: false,
      message: "Server error while processing clicks",
    });
  }
});

router.get("/post/details", async (req, res) => {
  try {
    const { url, platform, userId } = req.query;

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
      user: userId,
      url,
      platform,
    }).lean();

    if (!post) {
      return res.status(404).json({
        success: false,
        message: "Post not found",
      });
    }

    // For TikTok posts, check if the existing video URL is accessible
    if (platform === "tiktok" && post.videoPath) {
      try {
        // Try to access the existing video URL with proper headers
        const response = await axios.get(post.videoPath, {
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            Accept: "video/mp4,video/*;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
            Referer: "https://www.tiktok.com/",
            Origin: "https://www.tiktok.com",
            "Sec-Fetch-Dest": "video",
            "Sec-Fetch-Mode": "cors",
            "Sec-Fetch-Site": "cross-site",
          },
          validateStatus: function (status) {
            return status < 500; // Accept all status codes less than 500
          },
          maxRedirects: 5,
          timeout: 5000,
        });
        console.log(response);
        if (
          response.status === 403 ||
          !response.headers["content-type"]?.includes("video")
        ) {
          console.log("TikTok video URL check failed, fetching fresh URL.");
          const tikwmUrl = `https://www.tikwm.com/api/?url=${encodeURIComponent(
            url
          )}`;
          const freshResponse = await axios.get(tikwmUrl);

          if (freshResponse.data && freshResponse.data.data) {
            // Update the post with the fresh video URL
            post.videoPath = freshResponse.data.data.wmplay || post.videoPath;
            console.log("Updated TikTok video URL.");
          }
        }
      } catch (error) {
        console.error("Error checking TikTok video URL:", error);
        // If there's an error checking the URL, fetch a fresh one
        try {
          console.log("Error checking video URL, fetching fresh URL.");
          const tikwmUrl = `https://www.tikwm.com/api/?url=${encodeURIComponent(
            url
          )}`;
          const freshResponse = await axios.get(tikwmUrl);

          if (freshResponse.data && freshResponse.data.data) {
            post.videoPath = freshResponse.data.data.wmplay || post.videoPath;
            console.log("Updated TikTok video URL after error.");
          }
        } catch (freshError) {
          console.error("Error fetching fresh TikTok video URL:", freshError);
          // Continue with the existing videoPath if fetching fails
        }
      }
    }

    await Click.create({
      user: userId,
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
        _id: post._id,
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

    console.log("📷 Instagram upload request received for URL:", postUrl);

    if (!postUrl) {
      console.log("❌ Error: Missing post URL in request body");
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
      console.log("📝 Detected embed code in URL field, extracting actual URL");
      originalEmbedCode = postUrl;
      const urlMatch = postUrl.match(
        /https:\/\/www\.instagram\.com\/p\/[^\/'"]+/
      );
      if (urlMatch) {
        processedUrl = urlMatch[0];
        console.log(
          "✅ Extracted Instagram URL from embed code:",
          processedUrl
        );
      } else {
        console.log("❌ Failed to extract URL from embed code");
      }
    }
    // If the separate embed code is provided and URL is not an embed code
    else if (
      embedCode &&
      embedCode.includes("<blockquote") &&
      embedCode.includes("instagram-media")
    ) {
      originalEmbedCode = embedCode;
      console.log("📝 Using provided embed code");

      // Try to extract URL from embed code if URL looks invalid
      if (!processedUrl.includes("instagram.com")) {
        const urlMatch = embedCode.match(
          /https:\/\/www\.instagram\.com\/p\/[^\/'"]+/
        );
        if (urlMatch) {
          processedUrl = urlMatch[0];
          console.log(
            "✅ Extracted Instagram URL from embed code field:",
            processedUrl
          );
        } else {
          console.log("❌ Failed to extract URL from embed code field");
        }
      }
    }

    const isEmbedUrl =
      processedUrl.includes("/embed") && processedUrl.includes("instagram.com");

    if (!isEmbedUrl && processedUrl.includes("instagram.com")) {
      const shortcodeMatch = processedUrl.match(/\/(p|reel|tv)\/([^\/\?]+)/);
      if (shortcodeMatch && shortcodeMatch[2]) {
        const shortcode = shortcodeMatch[2];

        // IMPORTANT CHANGE: Don't use embed URL, use direct post URL
        // Using embed URLs might lead to profile images instead of post images
        // processedUrl = `https://www.instagram.com/p/${shortcode}/embed/`;
        processedUrl = `https://www.instagram.com/p/${shortcode}/`;
        console.log(
          "🔄 Using direct Instagram post URL instead of embed URL:",
          processedUrl
        );
      } else {
        console.log("⚠️ Could not extract shortcode from Instagram URL");
      }
    } else if (isEmbedUrl) {
      // Convert embed URL to direct post URL
      processedUrl = processedUrl.replace("/embed/", "/");
      console.log(
        "🔄 Converting Instagram embed URL to direct post URL:",
        processedUrl
      );
    }

    if (
      !/^https?:\/\/(www\.)?instagram\.com\/(p|reel|tv)\/[a-zA-Z0-9_-]+/.test(
        processedUrl
      )
    ) {
      console.log("❌ Invalid Instagram URL format:", processedUrl);
      return res.status(400).json({
        success: false,
        message: "Invalid Instagram URL. Must be a post, reel, or TV URL",
      });
    }

    try {
      console.log(
        "🔍 Attempting to extract Instagram image from:",
        processedUrl
      );

      // Add user agent that acts like a normal browser to avoid profile pic issues
      const { data } = await axios.get(processedUrl, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
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

      console.log("✅ Successfully fetched Instagram page HTML");

      let imageUrl = null;
      let extractionMethod = "";
      const $ = cheerio.load(data);

      // Log all meta tags for debugging
      console.log("📋 Meta Tags Found:");
      $("meta").each((i, el) => {
        const property = $(el).attr("property");
        const content = $(el).attr("content");
        if (property && content) {
          console.log(
            `  ${property}: ${content.substring(0, 100)}${
              content.length > 100 ? "..." : ""
            }`
          );
        }
      });

      // Try to extract image URL from meta tags, prioritizing more specific post image tags
      // Check for post-specific and content-specific meta tags first
      console.log("🔍 DETAILED DEBUG: Beginning meta tag extraction");
      console.log("-----------------------------------------------------");

      // Log all image-related meta tags specifically
      console.log("📸 All image-related meta tags:");
      const imageTags = [
        "og:image",
        "og:image:url",
        "og:image:secure_url",
        "twitter:image",
        "twitter:image:src",
        "instagram:image",
        "image",
        "thumbnail",
      ];

      const metaImageUrls = {};
      imageTags.forEach((tag) => {
        const propContent = $(`meta[property="${tag}"]`).attr("content");
        const nameContent = $(`meta[name="${tag}"]`).attr("content");
        if (propContent) {
          metaImageUrls[`property:${tag}`] = propContent;
          console.log(
            `  [property:${tag}] = ${propContent.substring(0, 100)}${
              propContent.length > 100 ? "..." : ""
            }`
          );
        }
        if (nameContent) {
          metaImageUrls[`name:${tag}`] = nameContent;
          console.log(
            `  [name:${tag}] = ${nameContent.substring(0, 100)}${
              nameContent.length > 100 ? "..." : ""
            }`
          );
        }
      });

      // Check for image dimensions in meta tags (useful for filtering out small images)
      const ogImageWidth = $('meta[property="og:image:width"]').attr("content");
      const ogImageHeight = $('meta[property="og:image:height"]').attr(
        "content"
      );
      if (ogImageWidth && ogImageHeight) {
        console.log(
          `📏 Meta image dimensions: ${ogImageWidth}x${ogImageHeight}`
        );
      }

      imageUrl =
        $('meta[property="og:image:url"]').attr("content") ||
        $('meta[property="og:image:secure_url"]').attr("content") ||
        $('meta[name="twitter:image"]').attr("content") ||
        $('meta[property="og:image"]').attr("content");

      if (imageUrl) {
        // Check if the image might be a profile pic rather than a post image
        const isLikelyProfilePic =
          imageUrl.includes("/profile_pic/") ||
          imageUrl.includes("profile_images") ||
          imageUrl.includes("/dp/") ||
          (imageUrl.includes("instagram.com") && imageUrl.includes("s150x150"));

        console.log("🔍 PROFILE PIC CHECK: Examining selected image URL");
        console.log(`📝 Selected URL: ${imageUrl}`);
        console.log(
          `🚫 Profile URL patterns: ${
            isLikelyProfilePic ? "DETECTED" : "None found"
          }`
        );

        if (isLikelyProfilePic) {
          console.log(
            "⚠️ URL ANALYSIS: This appears to be a profile picture based on URL pattern"
          );
          // Additional checks to confirm it's a profile pic
          const profileIndicators = [];
          if (imageUrl.includes("/profile_pic/"))
            profileIndicators.push("Contains '/profile_pic/'");
          if (imageUrl.includes("profile_images"))
            profileIndicators.push("Contains 'profile_images'");
          if (imageUrl.includes("/dp/"))
            profileIndicators.push("Contains '/dp/' (display picture)");
          if (imageUrl.includes("s150x150"))
            profileIndicators.push(
              "Contains 's150x150' (common profile thumbnail size)"
            );
          console.log(`🔎 Profile indicators: ${profileIndicators.join(", ")}`);
        }

        if (!isLikelyProfilePic) {
          extractionMethod = "og_image";
          console.log(
            "✅ Found image in meta tags:",
            imageUrl.substring(0, 100) + (imageUrl.length > 100 ? "..." : "")
          );
        } else {
          console.log(
            "⚠️ Found meta tag image but it appears to be a profile picture, looking for better options:",
            imageUrl
          );
          // Save this as a fallback but continue searching
          const profileImageUrl = imageUrl;
          imageUrl = null;

          // Look for content-specific meta tags
          const contentTags = [
            "article:image",
            "og:image:url",
            "twitter:image:src",
            "image",
            "thumbnail",
            "instagram:image",
          ];

          console.log("🔍 DETAILED DEBUG: Searching alternative meta tags");
          for (const tag of contentTags) {
            const tagContent =
              $(`meta[property="${tag}"]`).attr("content") ||
              $(`meta[name="${tag}"]`).attr("content");
            if (tagContent) {
              console.log(
                `📝 Found [${tag}]: ${tagContent.substring(0, 100)}${
                  tagContent.length > 100 ? "..." : ""
                }`
              );

              const isTagProfilePic =
                tagContent.includes("/profile_pic/") ||
                tagContent.includes("profile_images") ||
                tagContent.includes("/dp/") ||
                (tagContent.includes("instagram.com") &&
                  tagContent.includes("s150x150"));

              console.log(
                `   Profile pic check: ${
                  isTagProfilePic ? "⚠️ LIKELY PROFILE" : "✅ NOT PROFILE"
                }`
              );

              if (tagContent && !isTagProfilePic) {
                imageUrl = tagContent;
                extractionMethod = `meta_tag_${tag.replace(":", "_")}`;
                console.log(
                  `✅ Found better image in ${tag} meta tag:`,
                  imageUrl.substring(0, 100) +
                    (imageUrl.length > 100 ? "..." : "")
                );
                break;
              }
            }
          }

          // If no better image found, revert to the profile image as last resort
          if (!imageUrl) {
            imageUrl = profileImageUrl;
            extractionMethod = "og_image_profile";
            console.log(
              "⚠️ No better images found, using profile image as fallback"
            );
          }
        }
      } else {
        console.log("⚠️ No og:image meta tag found");
      }

      console.log("-----------------------------------------------------");

      // If no image found in meta tags, try to find it in the HTML content
      if (!imageUrl) {
        console.log(
          "🔍 DETAILED DEBUG: Looking for display_url in HTML content"
        );
        console.log("-----------------------------------------------------");

        // Look for display_resources or display_url in JSON data
        const jsonDataMatches = data.match(
          /window\._sharedData\s*=\s*({.+?});<\/script>/
        );
        if (jsonDataMatches && jsonDataMatches[1]) {
          try {
            const jsonData = JSON.parse(jsonDataMatches[1]);
            console.log("✅ Found Instagram shared data JSON");

            // Dump some structure info for debugging
            console.log("📊 JSON Structure:");
            if (jsonData.entry_data) {
              console.log(
                "  entry_data keys:",
                Object.keys(jsonData.entry_data)
              );
              if (jsonData.entry_data.PostPage) {
                console.log("  PostPage found");
              } else if (jsonData.entry_data.ProfilePage) {
                console.log(
                  "  ProfilePage found (this might explain profile pic issues)"
                );
              }
            } else {
              console.log("  No entry_data found");
            }

            // Navigate through the JSON structure to find post image
            let postMedia = null;

            // Try to find media in different possible locations
            if (
              jsonData.entry_data &&
              jsonData.entry_data.PostPage &&
              jsonData.entry_data.PostPage[0] &&
              jsonData.entry_data.PostPage[0].graphql &&
              jsonData.entry_data.PostPage[0].graphql.shortcode_media
            ) {
              postMedia =
                jsonData.entry_data.PostPage[0].graphql.shortcode_media;
              console.log("✅ Found post media in PostPage structure");
              console.log(
                "📊 Media type:",
                postMedia.is_video ? "VIDEO" : "IMAGE"
              );
              if (postMedia.__typename) {
                console.log("📊 Media typename:", postMedia.__typename);
              }
            }
            // Try alternative structures
            else if (
              jsonData.entry_data &&
              jsonData.entry_data.ProfilePage &&
              jsonData.entry_data.ProfilePage[0] &&
              jsonData.entry_data.ProfilePage[0].graphql &&
              jsonData.entry_data.ProfilePage[0].graphql.user &&
              jsonData.entry_data.ProfilePage[0].graphql.user
                .edge_owner_to_timeline_media &&
              jsonData.entry_data.ProfilePage[0].graphql.user
                .edge_owner_to_timeline_media.edges &&
              jsonData.entry_data.ProfilePage[0].graphql.user
                .edge_owner_to_timeline_media.edges.length > 0
            ) {
              postMedia =
                jsonData.entry_data.ProfilePage[0].graphql.user
                  .edge_owner_to_timeline_media.edges[0].node;
              console.log("✅ Found post media in ProfilePage structure");
              console.log(
                "⚠️ WARNING: Using ProfilePage might use the wrong image"
              );

              // Check for profile pic
              const profilePicUrl =
                jsonData.entry_data.ProfilePage[0].graphql.user.profile_pic_url;
              const profilePicUrlHD =
                jsonData.entry_data.ProfilePage[0].graphql.user
                  .profile_pic_url_hd;
              if (profilePicUrl) {
                console.log("⚠️ Profile pic URL found:", profilePicUrl);
                console.log("⚠️ Ensure we don't use this by mistake");
              }
              if (profilePicUrlHD) {
                console.log("⚠️ Profile pic URL HD found:", profilePicUrlHD);
                console.log("⚠️ Ensure we don't use this by mistake");
              }
            }

            // Extract the best quality image URL
            if (postMedia) {
              console.log("📊 Available media keys:", Object.keys(postMedia));

              // Check for display_resources (contains multiple sizes)
              if (
                postMedia.display_resources &&
                Array.isArray(postMedia.display_resources) &&
                postMedia.display_resources.length > 0
              ) {
                // Sort by size and get the largest
                const sortedResources = [...postMedia.display_resources].sort(
                  (a, b) => {
                    return (
                      b.config_width * b.config_height -
                      a.config_width * a.config_height
                    );
                  }
                );

                console.log(
                  "📊 Display resources found:",
                  postMedia.display_resources.length
                );
                postMedia.display_resources.forEach((res, idx) => {
                  console.log(
                    `  Resource ${idx + 1}: ${res.config_width}x${
                      res.config_height
                    } - ${res.src.substring(0, 100)}...`
                  );
                });

                imageUrl = sortedResources[0].src;
                extractionMethod = "json_display_resources";
                console.log(
                  "✅ Found high-quality image in display_resources:",
                  imageUrl.substring(0, 100) +
                    (imageUrl.length > 100 ? "..." : "")
                );
                console.log(
                  `📏 Image dimensions: ${sortedResources[0].config_width}x${sortedResources[0].config_height}`
                );
              }
              // Fallback to display_url
              else if (postMedia.display_url) {
                imageUrl = postMedia.display_url;
                extractionMethod = "json_display_url";
                console.log(
                  "✅ Found image in display_url:",
                  imageUrl.substring(0, 100) +
                    (imageUrl.length > 100 ? "..." : "")
                );

                // Log dimensions if available
                if (postMedia.dimensions) {
                  console.log(
                    `📏 Image dimensions: ${postMedia.dimensions.width}x${postMedia.dimensions.height}`
                  );
                }
              }
            }
          } catch (jsonError) {
            console.error(
              "❌ Error parsing Instagram JSON data:",
              jsonError.message
            );
            console.error("JSON parse error details:", jsonError);
          }
        } else {
          console.log("⚠️ Could not find Instagram shared data JSON");
        }

        // Fallback: Try simple regex for display_url if JSON parsing failed
        if (!imageUrl) {
          console.log("🔍 Attempting fallback: regex search for display_url");

          const displayUrlRegexes = [
            /"display_url":"([^"]+)"/,
            /"display_src":"([^"]+)"/,
            /"og:image":"([^"]+)"/,
            /<img[^>]+class="FFVAD"[^>]+src="([^"]+)"/,
          ];

          for (const regex of displayUrlRegexes) {
            console.log(`🔍 Trying regex: ${regex}`);
            const match = data.match(regex);
            if (match && match[1]) {
              const potentialUrl = match[1].replace(/\\/g, "");
              console.log(
                `📝 Found match: ${potentialUrl.substring(0, 100)}${
                  potentialUrl.length > 100 ? "..." : ""
                }`
              );

              // Skip if it looks like a profile picture
              const isLikelyProfilePic =
                potentialUrl.includes("/profile_pic/") ||
                potentialUrl.includes("profile_images") ||
                potentialUrl.includes("/dp/");

              console.log(
                `🚫 Profile URL check: ${
                  isLikelyProfilePic ? "DETECTED" : "Not detected"
                }`
              );

              if (!isLikelyProfilePic) {
                imageUrl = potentialUrl;
                extractionMethod = "display_url_regex";
                console.log(
                  "✅ Found image in display_url regex:",
                  imageUrl.substring(0, 100) +
                    (imageUrl.length > 100 ? "..." : "")
                );
                break;
              } else {
                console.log(
                  "⚠️ Skipped profile image found in display_url:",
                  potentialUrl.substring(0, 100) +
                    (potentialUrl.length > 100 ? "..." : "")
                );
              }
            }
          }

          if (!imageUrl) {
            console.log("⚠️ No display_url found using any regex pattern");
          }
        }

        console.log("-----------------------------------------------------");
      }

      // Try another fallback method - look for image tags with specific patterns
      if (!imageUrl) {
        console.log("🔍 DETAILED DEBUG: Looking for image tags in HTML");
        console.log("-----------------------------------------------------");

        // First, look for post content images specifically (typically larger images)
        console.log("❌ Could not find any image URL for the Instagram post");
        return res.status(404).json({
          success: false,
          message: "Could not find image for the Instagram post",
        });
      }

      if (imageUrl.startsWith("//")) {
        imageUrl = "https:" + imageUrl;
        console.log("🔄 Added https: prefix to image URL");
      }

      console.log("🖼️ Original URL:", imageUrl);
      const originalUrl = imageUrl;

      // Clean up the URL
      const cleanedUrl = imageUrl
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

      imageUrl = cleanedUrl
        .replace(/\\u0026/g, "&")
        .replace(/\\u003D/g, "=")
        .replace(/\\/g, "");

      if (originalUrl !== imageUrl) {
        console.log("🔄 Transformed URL to remove cropping:", imageUrl);
      }

      // FINAL PROFILE IMAGE CHECK - Check one more time if this URL has profile image patterns
      // This is a critical last check to avoid downloading profile images
      const finalProfileImagePatterns = [
        "/profile_pic/",
        "profile_images",
        "/profpic/",
        "/pp/",
        "/dp/",
        "s150x150",
        "/profile/",
        "/profil/",
        "avatar",
        ".com/p/profile",
      ];

      let hasProfilePattern = false;
      for (const pattern of finalProfileImagePatterns) {
        if (imageUrl.includes(pattern)) {
          hasProfilePattern = true;
          console.log(
            `⚠️ CRITICAL: Final check detected profile image pattern "${pattern}"`
          );
          console.log(`⚠️ URL: ${imageUrl}`);

          // If we're sure this is a profile image, try to get a larger image from the HTML
          console.log(
            "🔍 EMERGENCY FALLBACK: Looking for any large image in the page"
          );

          const imgElements = $("img");
          const candidateImages = [];

          imgElements.each((i, img) => {
            const src = $(img).attr("src");
            if (!src) return;

            // Skip known profile images
            if (
              finalProfileImagePatterns.some((pattern) => src.includes(pattern))
            ) {
              return;
            }

            const width = parseInt($(img).attr("width") || "0", 10);
            const height = parseInt($(img).attr("height") || "0", 10);

            // Only consider Instagram/Facebook CDN images
            if (src.includes("cdninstagram") || src.includes("fbcdn.net")) {
              candidateImages.push({
                src,
                width,
                height,
                size: width * height,
              });
            }
          });

          if (candidateImages.length > 0) {
            // Sort by size (largest first)
            candidateImages.sort((a, b) => b.size - a.size);

            console.log(
              `🔍 Found ${candidateImages.length} alternative images`
            );
            candidateImages.forEach((img, idx) => {
              console.log(
                `  Alternative ${idx + 1}: ${img.width}x${
                  img.height
                } - ${img.src.substring(0, 100)}...`
              );
            });

            // Use the largest image
            imageUrl = candidateImages[0].src;
            console.log(
              `✅ EMERGENCY REPLACEMENT: Using alternative image: ${imageUrl.substring(
                0,
                100
              )}...`
            );
            extractionMethod = "emergency_fallback";
            break;
          }
        }
      }

      if (hasProfilePattern && extractionMethod.includes("profile")) {
        console.log(
          "⚠️ WARNING: We're about to use what appears to be a profile image. This may not be what you want!"
        );
      }

      // Download and upload image to Cloudinary
      let cloudinaryImageUrl = "";
      try {
        console.log("⬇️ Downloading Instagram image from URL:", imageUrl);
        // Download the image with enhanced headers
        const response = await axios({
          method: "GET",
          url: imageUrl,
          responseType: "arraybuffer",
          headers: {
            "User-Agent":
              "Mozilla/5.0 (iPhone; CPU iPhone OS 14_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.0.3 Mobile/15E148 Safari/604.1",
            Referer: "https://www.instagram.com/",
            Accept: "image/webp,image/apng,image/*,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
            "Cache-Control": "no-cache",
            Origin: "https://www.instagram.com",
          },
          timeout: 15000,
        });

        console.log(
          "✅ Successfully downloaded image, content length:",
          response.data.length,
          "bytes"
        );
        console.log("Content-Type:", response.headers["content-type"]);

        if (!response.data || response.data.length < 1000) {
          throw new Error("Downloaded image is too small or empty");
        }

        // Check if the image is a reasonable size for a post (avoid tiny profile pics)
        const isReasonableSize = response.data.length > 10000; // Most profile pics are smaller than 10KB

        if (!isReasonableSize) {
          console.log(
            "⚠️ Downloaded image seems too small for a post image, might be a profile picture"
          );
          console.log("🔍 Searching for a better image...");

          // Try to re-extract with a stronger focus on post images
          // Here we can implement a more aggressive search through the HTML for larger images
          let betterImageFound = false;

          // Look for "high resolution" or "HD" markers in the HTML
          const hdImagePattern =
            /https:\/\/[^"']+?(?:1080x1080|high_resolution|hd|1080p)[^"']+\.(?:jpg|jpeg|png)/i;
          const hdMatch = data.match(hdImagePattern);

          if (hdMatch && hdMatch[0]) {
            console.log("✅ Found HD image match:", hdMatch[0]);

            try {
              // Try to download this better image
              const hdResponse = await axios({
                method: "GET",
                url: hdMatch[0],
                responseType: "arraybuffer",
                headers: {
                  "User-Agent":
                    "Mozilla/5.0 (iPhone; CPU iPhone OS 14_6 like Mac OS X) AppleWebKit/605.1.15",
                  Referer: "https://www.instagram.com/",
                  Accept: "image/webp,image/apng,image/*,*/*;q=0.8",
                },
                timeout: 15000,
              });

              if (
                hdResponse.data &&
                hdResponse.data.length > response.data.length
              ) {
                console.log(
                  "✅ Successfully downloaded better quality image, size:",
                  hdResponse.data.length,
                  "bytes"
                );
                response.data = hdResponse.data; // Replace with better image
                betterImageFound = true;
              }
            } catch (hdError) {
              console.error(
                "❌ Error downloading better quality image:",
                hdError.message
              );
            }
          }

          if (!betterImageFound) {
            console.log(
              "⚠️ Could not find a better image, continuing with the original one"
            );
          }
        }

        // Create a noop function that does nothing for setUploading
        const noopSetUploading = (state) => {
          console.log(`📊 Upload state: ${state ? "uploading" : "complete"}`);
        };

        // Upload to Cloudinary using the buffer directly
        console.log("☁️ Uploading to Cloudinary...");
        cloudinaryImageUrl = await uploadFile(
          Buffer.from(response.data),
          noopSetUploading
        );

        console.log(
          "✅ Successfully uploaded image to Cloudinary:",
          cloudinaryImageUrl
        );
      } catch (uploadError) {
        console.error("❌ Error uploading image to Cloudinary:", uploadError);

        // Log more details about the error
        if (uploadError.response) {
          console.error("Response status:", uploadError.response.status);
          console.error(
            "Response headers:",
            JSON.stringify(uploadError.response.headers, null, 2)
          );
        }

        // Try direct URL method as fallback
        try {
          console.log("🔄 Trying fallback: direct URL upload to Cloudinary");
          const noopSetUploading = (state) => {
            console.log(`📊 Upload state: ${state ? "uploading" : "complete"}`);
          };

          cloudinaryImageUrl = await uploadFile(imageUrl, noopSetUploading);
          console.log(
            "✅ Fallback succeeded, Cloudinary URL:",
            cloudinaryImageUrl
          );
        } catch (fallbackError) {
          console.error("❌ Fallback upload also failed:", fallbackError);
          // Fallback to original image URL if both Cloudinary uploads fail
          console.log("⚠️ Using original Instagram image URL as fallback");
          cloudinaryImageUrl = imageUrl;
        }
      }

      const originalPostUrl = isEmbedUrl
        ? processedUrl.replace("/embed/", "/")
        : processedUrl;

      // Create new post using Post model
      console.log("💾 Creating database record for Instagram post");
      const post = await Post.create({
        user: req.user._id,
        platform: "instagram",
        url: postUrl,
        imageUrl: cloudinaryImageUrl || imageUrl,
        embedCode: originalEmbedCode,
        title: "",
        description: "",
      });

      console.log("✅ Successfully created Instagram post with ID:", post._id);

      return res.status(200).json({
        success: true,
        platform: "instagram",
        url: postUrl,
        imageUrl: cloudinaryImageUrl || imageUrl,
        extractionMethod: extractionMethod,
        _id: post._id,
        message: "Instagram post image added successfully",
      });
    } catch (error) {
      console.error("❌ Instagram scraping error:", error);
      // Log detailed error information
      if (error.response) {
        console.error("Response status:", error.response.status);
        console.error(
          "Response headers:",
          JSON.stringify(error.response.headers, null, 2)
        );
      }
      return res.status(404).json({
        success: false,
        message:
          "Error accessing Instagram post. It may be private or not publicly accessible.",
        error: error.message,
      });
    }
  } catch (error) {
    console.error("❌ Instagram API error:", error);
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
    console.log("Starting Facebook image extraction for URL:", url);

    // First try to get the image from the meta tags
    const response = await axios.get(url, {
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
      },
      timeout: 10000,
      maxRedirects: 5,
    });

    const html = response.data;
    console.log("Successfully fetched Facebook page HTML");

    // Try to find the image URL in meta tags first
    const metaImageMatch = html.match(
      /<meta[^>]*property="og:image"[^>]*content="([^"]*)"/i
    );
    if (metaImageMatch && metaImageMatch[1]) {
      const imageUrl = metaImageMatch[1].replace(/&amp;/g, "&");
      console.log("Found image URL in meta tags:", imageUrl);
      return imageUrl;
    }

    // If meta tag not found, try to find the image in the HTML content
    const imageMatch = html.match(
      /<img[^>]*src="([^"]*)"[^>]*class="[^"]*scaledImageFitWidth[^"]*"/i
    );
    if (imageMatch && imageMatch[1]) {
      const imageUrl = imageMatch[1].replace(/&amp;/g, "&");
      console.log("Found image URL in HTML content:", imageUrl);
      return imageUrl;
    }

    // If still not found, try to find any image with specific Facebook classes
    const fallbackImageMatch = html.match(
      /<img[^>]*src="([^"]*)"[^>]*class="[^"]*x1ey2m1c[^"]*"/i
    );
    if (fallbackImageMatch && fallbackImageMatch[1]) {
      const imageUrl = fallbackImageMatch[1].replace(/&amp;/g, "&");
      console.log("Found fallback image URL:", imageUrl);
      return imageUrl;
    }

    // Try to find any image URL in the page
    const anyImageMatch = html.match(
      /https:\/\/[^"']*\.(?:jpg|jpeg|png|gif|webp)[^"']*/i
    );
    if (anyImageMatch) {
      const imageUrl = anyImageMatch[0].replace(/&amp;/g, "&");
      console.log("Found general image URL:", imageUrl);
      return imageUrl;
    }

    console.log("No suitable image URL found in the Facebook post");
    return null;
  } catch (error) {
    console.error("Error extracting Facebook image URL:", error.message);
    if (error.response) {
      console.error("Response status:", error.response.status);
      console.error("Response headers:", error.response.headers);
    }
    return null;
  }
};

router.post("/facebook", protect, async (req, res) => {
  try {
    const { url: postUrl } = req.body;

    if (!postUrl) {
      return res.status(400).json({
        success: false,
        message: "Post URL is required in the request body",
      });
    }

    // Update regex to better handle share/v/ URLs
    if (
      !/^https?:\/\/(www\.)?(facebook|fb)\.com\/[a-zA-Z0-9.]+\/posts\/|^https?:\/\/(www\.)?(facebook|fb)\.com\/[a-zA-Z0-9.]+\/photos\/|^https?:\/\/(www\.)?(facebook|fb)\.com\/share\/[pv]\/[a-zA-Z0-9_-]+\/?|^https?:\/\/(www\.)?(facebook|fb)\.com\/[a-zA-Z0-9.]+\/videos\/[0-9]+\/?/.test(
        postUrl
      )
    ) {
      return res.status(400).json({
        success: false,
        message:
          "Invalid Facebook URL. Must be a post, photo, video, or share URL",
      });
    }

    // Flag if this is a share/v/ format URL (video share)
    const isVideoShareUrl = postUrl.includes("/share/v/");

    try {
      const headers = {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept-Encoding": "gzip, deflate, br",
        Referer: "https://www.facebook.com/",
        "Cache-Control": "no-cache",
        Pragma: "no-cache",
        DNT: "1",
        Connection: "keep-alive",
        "Upgrade-Insecure-Requests": "1",
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "same-origin",
        "Sec-Fetch-User": "?1",
        "sec-ch-ua":
          '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": '"Windows"',
      };

      const { data } = await axios.get(postUrl, {
        headers,
        timeout: 15000,
        maxRedirects: 5,
      });

      let imageUrl = null;
      let extractionMethod = "";

      // Try to extract image URL from meta tags first
      const $ = cheerio.load(data);

      // Enhanced meta tag extraction with detailed logging
      const metaTags = {};
      $("meta").each((i, meta) => {
        const property = $(meta).attr("property");
        const content = $(meta).attr("content");
        if (property && content) {
          metaTags[property] = content;
        }
      });

      // Check for video thumbnail specifically
      if (isVideoShareUrl) {
        // Try og:image first for videos
        imageUrl = metaTags["og:image"];
        if (imageUrl) {
          extractionMethod = "og_image_video";
        }
      } else {
        // Standard processing for non-video URLs
        imageUrl = $('meta[property="og:image"]').attr("content");
        if (imageUrl) {
          extractionMethod = "og_image";
        }
      }

      // If no image found in meta tags, try to find it in the HTML content
      if (!imageUrl) {
        const imgElements = $("img");

        for (const img of imgElements) {
          const src = $(img).attr("src");

          if (src) {
            if (
              src.includes("scontent") ||
              src.includes("fbcdn") ||
              src.includes("facebook.com/images")
            ) {
              imageUrl = src;
              extractionMethod = "html_content";
              break;
            }
          }
        }
      }

      // For video share URLs, try to find video poster or preview image if still no image
      if (!imageUrl && isVideoShareUrl) {
        // Look for video elements
        const videoElements = $("video");

        for (const video of videoElements) {
          const poster = $(video).attr("poster");
          if (poster) {
            imageUrl = poster;
            extractionMethod = "video_poster";
            break;
          }
        }

        // Look for specific video container elements
        if (!imageUrl) {
          $("[data-video-id]").each((i, el) => {
            const style = $(el).attr("style");

            if (style && style.includes("background-image")) {
              const bgMatch = style.match(
                /background-image: ?url\(['"]?([^'")]+)['"]?\)/i
              );
              if (bgMatch && bgMatch[1]) {
                imageUrl = bgMatch[1];
                extractionMethod = "video_container_bg";
                return false; // Break each loop
              }
            }
          });
        }
      }

      // If still no image found, try JSON-LD for structured data
      if (!imageUrl) {
        $('script[type="application/ld+json"]').each((i, script) => {
          try {
            const jsonLd = JSON.parse($(script).html());

            if (jsonLd.image) {
              if (Array.isArray(jsonLd.image) && jsonLd.image.length > 0) {
                imageUrl = jsonLd.image[0];
              } else if (typeof jsonLd.image === "string") {
                imageUrl = jsonLd.image;
              }

              if (imageUrl) {
                extractionMethod = "json_ld";
              }
            }
          } catch (error) {
            // Silently continue on parse error
          }
        });
      }

      // Last resort: look for any image URL in the HTML that matches Facebook CDN patterns
      if (!imageUrl) {
        const fbcdnPattern =
          /https:\/\/[a-z0-9-]+\.fbcdn\.net\/[a-z0-9_\/.]+\.(?:jpg|jpeg|png|gif)/gi;
        const matches = data.match(fbcdnPattern);

        if (matches && matches.length > 0) {
          // Use the first match that's not a tiny image (profile pics, etc.)
          for (const match of matches) {
            // Prefer larger images that don't contain typical small image patterns
            if (
              !match.includes("profile") &&
              !match.includes("_s.") &&
              !match.includes("emoji")
            ) {
              imageUrl = match;
              extractionMethod = "fbcdn_regex_match";
              break;
            }
          }

          // If we didn't find a preferred image, just use the first one
          if (!imageUrl && matches.length > 0) {
            imageUrl = matches[0];
            extractionMethod = "fbcdn_regex_first_match";
          }
        }
      }

      if (!imageUrl) {
        return res.status(404).json({
          success: false,
          message: "Could not find image for the Facebook post",
        });
      }

      if (imageUrl.startsWith("//")) {
        imageUrl = "https:" + imageUrl;
      }

      const originalUrl = imageUrl;

      // Clean up the URL
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

      // Facebook CDN URLs have anti-hotlinking measures, directly save the URL
      // instead of trying to download and reupload (which likely results in 403 errors)
      let cloudinaryImageUrl = "";
      const fbImageHostnames = ["scontent", "fbcdn", "facebook.com"];
      const isFacebookCDNImage = fbImageHostnames.some((host) =>
        imageUrl.includes(host)
      );

      if (isFacebookCDNImage) {
        try {
          // Simple approach: Try to download image with enhanced headers
          const response = await axios({
            method: "GET",
            url: imageUrl,
            responseType: "arraybuffer",
            timeout: 15000,
            headers: {
              "User-Agent":
                "Mozilla/5.0 (iPhone; CPU iPhone OS 14_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.0.3 Mobile/15E148 Safari/604.1",
              Accept: "image/webp,image/png,image/svg+xml,image/*;q=0.8",
              "Accept-Language": "en-US,en;q=0.9",
              Origin: "https://www.facebook.com",
              Referer: postUrl,
              "sec-fetch-dest": "image",
              "sec-fetch-mode": "no-cors",
              "sec-fetch-site": "cross-site",
            },
          });

          if (response.data && response.data.length > 1000) {
            // Upload to Cloudinary using standard method
            cloudinaryImageUrl = await uploadFile(
              Buffer.from(response.data),
              () => {}
            );
          } else {
            throw new Error(
              "Facebook image download returned insufficient data"
            );
          }
        } catch (downloadError) {
          // Fallback to original OG image URL without any modifications
          if (isVideoShareUrl) {
            try {
              // Try downloading the preview image from Facebook
              // For video content, we use the OG image url directly with no modifications
              const videoImageUrl = metaTags["og:image"];

              if (videoImageUrl) {
                const videoResponse = await axios({
                  method: "GET",
                  url: videoImageUrl,
                  responseType: "arraybuffer",
                  timeout: 15000,
                  headers: {
                    "User-Agent":
                      "Mozilla/5.0 (iPhone; CPU iPhone OS 14_6 like Mac OS X) AppleWebKit/605.1.15",
                    Accept: "image/webp,image/png,image/svg+xml,image/*;q=0.8",
                    "Accept-Language": "en-US,en;q=0.9",
                    Origin: "https://www.facebook.com",
                    Referer: postUrl,
                  },
                });

                if (videoResponse.data && videoResponse.data.length > 1000) {
                  // Upload to Cloudinary
                  cloudinaryImageUrl = await uploadFile(
                    Buffer.from(videoResponse.data),
                    () => {}
                  );
                } else {
                  throw new Error(
                    "Video image download returned insufficient data"
                  );
                }
              } else {
                throw new Error("No OG image URL found for video content");
              }
            } catch (videoError) {
              // If all else fails, use Facebook logo
              cloudinaryImageUrl =
                "https://static.xx.fbcdn.net/rsrc.php/v3/y4/r/-PAXP-deijE.gif";
            }
          } else {
            // Non-video content, use original URL
            cloudinaryImageUrl = imageUrl;
          }
        }
      } else {
        // For non-Facebook CDN images, try direct download
        try {
          // Download the image
          const response = await axios({
            method: "GET",
            url: imageUrl,
            responseType: "arraybuffer",
            timeout: 10000,
            headers: {
              "User-Agent":
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
              Referer: "https://www.facebook.com/",
              Accept: "image/webp,image/apng,image/*,*/*;q=0.8",
            },
          });

          // Upload to Cloudinary using the buffer directly
          cloudinaryImageUrl = await uploadFile(
            Buffer.from(response.data),
            () => {}
          );
        } catch (uploadError) {
          // Fallback to original image URL if Cloudinary upload fails
          cloudinaryImageUrl = imageUrl;
        }
      }

      // Create new post using Post model
      const post = await Post.create({
        user: req.user._id,
        platform: "facebook",
        url: postUrl,
        imageUrl: cloudinaryImageUrl || imageUrl,
        title: metaTags["og:title"] || "",
        description: metaTags["og:description"] || "",
      });

      // Send the response back to the frontend
      return res.status(200).json({
        success: true,
        platform: "facebook",
        url: postUrl,
        imageUrl: cloudinaryImageUrl || imageUrl,
        extractionMethod: extractionMethod,
        _id: post._id,
        message: "Facebook post image added successfully",
      });
    } catch (error) {
      // If all methods fail, use a Facebook logo as fallback
      const fallbackImageUrl =
        "https://static.xx.fbcdn.net/rsrc.php/v3/y4/r/-PAXP-deijE.gif";

      try {
        const post = await Post.create({
          user: req.user._id,
          platform: "facebook",
          url: postUrl,
          imageUrl: fallbackImageUrl,
          title: "",
          description: "",
        });

        return res.status(200).json({
          success: true,
          platform: "facebook",
          url: postUrl,
          imageUrl: fallbackImageUrl,
          extractionMethod: "fallback_logo",
          _id: post._id,
          message: "Facebook post added with fallback image",
        });
      } catch (fallbackError) {
        return res.status(500).json({
          success: false,
          message: "Error creating Facebook post",
          error: fallbackError.message,
        });
      }
    }
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Error fetching Facebook image",
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

    // Allow overriding the posts count via query parameter
    const postsCount = req.query.count
      ? parseInt(req.query.count)
      : parseInt(feedSettings?.postsCount || "6");

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

    // Add a unique identifier to the cached URL to avoid conflicts
    // We don't actually modify the URL, we're just not caching it
    // Because we're directly streaming the response, there's no need to cache

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

// Get total clicks by platform

// Update post details
router.post("/post/update-details", protect, async (req, res) => {
  try {
    const { postId, title, description, productLink } = req.body;

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
        title,
        description,
        productLink,
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
      message: "Post details updated successfully",
      data: updatedPost,
    });
  } catch (error) {
    console.error("Error updating post details:", error);
    res.status(500).json({
      success: false,
      message: "Error updating post details",
      error: error.message,
    });
  }
});

// Add a test route for Cloudinary configuration
router.get("/cloudinary-test", protect, async (req, res) => {
  try {
    console.log("📊 Testing Cloudinary configuration");

    // Check if environment variables are set
    const apiKey = process.env.CLOUDINARY_API_KEY;
    const apiSecret = process.env.CLOUDINARY_API_SECRET;

    if (!apiKey || !apiSecret) {
      console.error("❌ Cloudinary credentials missing in environment");
      return res.status(500).json({
        success: false,
        message: "Cloudinary configuration incomplete - missing credentials",
        details: {
          api_key_present: !!apiKey,
          api_secret_present: !!apiSecret,
        },
      });
    }

    // Test Cloudinary connectivity with a ping
    const pingResult = await cloudinary.api.ping();

    // Try to upload a test image to verify full access
    // Create a simple 1x1 pixel transparent PNG as base64
    const testImageBase64 =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

    const uploadResult = await cloudinary.uploader.upload(testImageBase64, {
      folder: "shoplinkify-test",
      public_id: "connectivity-test",
      overwrite: true,
    });

    // If we get here, the upload was successful
    console.log("✅ Cloudinary test successful!");

    return res.status(200).json({
      success: true,
      message: "Cloudinary is properly configured and working",
      details: {
        ping: pingResult,
        upload_test: {
          url: uploadResult.secure_url,
          public_id: uploadResult.public_id,
        },
        config: {
          cloud_name: "dexeo4ce2",
          api_key_present: !!apiKey,
          api_secret_present: !!apiSecret,
        },
      },
    });
  } catch (error) {
    console.error("❌ Cloudinary test failed:", error);

    let errorDetails = {
      message: error.message,
    };

    if (error.http_code) {
      errorDetails.http_code = error.http_code;
    }

    if (error.response) {
      errorDetails.response = error.response.data || "See server logs";
    }

    return res.status(500).json({
      success: false,
      message: "Cloudinary configuration test failed",
      error: errorDetails,
    });
  }
});

module.exports = router;
