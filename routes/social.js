const express = require("express");
const router = express.Router();
const User = require("../models/User");
const axios = require("axios");
const { URL } = require("url");
const cheerio = require("cheerio");
const { protect } = require("../middleware/auth");

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

    // Create a standard YouTube URL
    const standardUrl = `https://www.youtube.com/watch?v=${videoId}`;
    const thumbnailUrl = `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`;

    // Save to user's profile
    req.user.youtubePosts.push({
      url: standardUrl,
      videoId: videoId,
      thumbnailUrl: thumbnailUrl,
      addedAt: new Date(),
    });
    await req.user.save();

    return res.status(200).json({
      success: true,
      platform: "youtube",
      url: standardUrl,
      videoId: videoId,
      thumbnailUrl: thumbnailUrl,
      message: "YouTube video added successfully",
    });
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

      req.user.instagramPosts.push({
        url: originalPostUrl,
        imageUrl: imageUrl,
        embedCode: originalEmbedCode,
        addedAt: new Date(),
      });
      await req.user.save();

      return res.status(200).json({
        success: true,
        platform: "instagram",
        url: originalPostUrl,
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

// Facebook post details endpoint
router.post("/facebook", protect, async (req, res) => {
  try {
    const { url: postUrl } = req.body;

    if (!postUrl) {
      return res.status(400).json({
        success: false,
        message: "Post URL is required in the request body",
      });
    }

    // Update regex to accept newer Facebook URL formats including share/p/ links
    if (
      !/^https?:\/\/(www\.)?(facebook|fb)\.com\/[a-zA-Z0-9.]+\/posts\/|^https?:\/\/(www\.)?(facebook|fb)\.com\/[a-zA-Z0-9.]+\/photos\/|^https?:\/\/(www\.)?(facebook|fb)\.com\/share\/p\/[a-zA-Z0-9_-]+\/|^https?:\/\/(www\.)?(facebook|fb)\.com\/share\/v\/[a-zA-Z0-9_-]+\//.test(
        postUrl
      )
    ) {
      return res.status(400).json({
        success: false,
        message: "Invalid Facebook URL. Must be a post, photo, or share URL",
      });
    }

    try {
      // Enhanced request headers to mimic a real browser more closely
      const headers = {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
        Referer: "https://www.google.com/",
        "Cache-Control": "no-cache",
        Pragma: "no-cache",
        DNT: "1",
        Connection: "keep-alive",
        "Upgrade-Insecure-Requests": "1",
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "none",
        "Sec-Fetch-User": "?1",
      };

      console.log("Attempting to fetch Facebook content from:", postUrl);
      const { data } = await axios.get(postUrl, {
        headers: headers,
        timeout: 15000,
        maxRedirects: 5,
      });

      console.log("Successfully fetched Facebook page HTML");
      const $ = cheerio.load(data);

      // First attempt: Try to get image from meta tags
      let imageUrl = $('meta[property="og:image"]').attr("content");
      let extractionMethod = "og_image";

      // Second attempt: Try other meta tags
      if (!imageUrl) {
        imageUrl =
          $('meta[property="og:image:secure_url"]').attr("content") ||
          $('meta[property="twitter:image"]').attr("content");
        extractionMethod = "alternative_meta";
      }

      // Third attempt: Look for image elements based on Facebook's structure
      if (!imageUrl) {
        // For /share/p/ URLs, try to find the image in a specific structure
        if (postUrl.includes("/share/p/")) {
          const possibleImages = $("img")
            .filter(function () {
              // Filter for images that are likely to be post content
              const src = $(this).attr("src");
              return (
                src &&
                (src.includes("fbcdn.net") ||
                  src.includes("scontent") ||
                  src.includes("facebook.com/safe_image.php"))
              );
            })
            .map(function () {
              return $(this).attr("src");
            })
            .get();

          // Try to find the largest image (typically the main content)
          if (possibleImages.length > 0) {
            imageUrl = possibleImages[0]; // Just use the first one as default
            for (const img of possibleImages) {
              // Prioritize high-resolution images
              if (img.includes("_n.") || img.includes("_o.")) {
                imageUrl = img;
                break;
              }
            }
            extractionMethod = "html_image";
          }
        }
      }

      // Fourth attempt: Try to extract from JSON-LD
      if (!imageUrl) {
        const scripts = $('script[type="application/ld+json"]')
          .map(function () {
            return $(this).html();
          })
          .get();

        for (const script of scripts) {
          try {
            const ldJson = JSON.parse(script);
            if (ldJson.image) {
              if (Array.isArray(ldJson.image)) {
                imageUrl = ldJson.image[0];
              } else {
                imageUrl = ldJson.image;
              }
              extractionMethod = "json_ld";
              break;
            }
          } catch (e) {
            // Invalid JSON, skip this script
          }
        }
      }

      // If still no image, try to look for patterns in the HTML that might contain image URL
      if (!imageUrl) {
        // Search for image URLs in the HTML
        const fbcdnPattern =
          /https:\/\/[a-z0-9-]+\.fbcdn\.net\/[a-z0-9_\/.]+\.(?:jpg|jpeg|png|gif)/gi;
        const matches = data.match(fbcdnPattern);
        if (matches && matches.length > 0) {
          // Use the first match (most likely to be the main image)
          imageUrl = matches[0];
          extractionMethod = "regex_match";
        }
      }

      if (!imageUrl) {
        // If a Facebook URL contains /share/p/, we can generate a default thumbnail
        if (postUrl.includes("/share/p/")) {
          // Extract the post ID
          const postIdMatch = postUrl.match(/\/share\/p\/([a-zA-Z0-9_-]+)/);
          if (postIdMatch && postIdMatch[1]) {
            // Use a generic Facebook post image
            imageUrl =
              "https://static.xx.fbcdn.net/rsrc.php/v3/y4/r/-PAXP-deijE.gif";
            extractionMethod = "fallback_share";
          }
        }
      }

      if (!imageUrl) {
        return res.status(404).json({
          success: false,
          message:
            "Could not find image for the Facebook post. This might be due to privacy settings or Facebook's anti-scraping measures.",
        });
      }

      // Verify image accessibility by making a HEAD request
      try {
        console.log("Verifying Facebook image accessibility:", imageUrl);
        await axios.head(imageUrl, {
          timeout: 5000,
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36",
            Referer: "https://www.facebook.com/",
          },
        });
        console.log("Facebook image is accessible");
      } catch (error) {
        console.log(
          "Warning: Facebook image may not be directly accessible:",
          error.message
        );
        // We'll still try to use it, but we'll note the warning
      }

      console.log(`Final Facebook image (via ${extractionMethod}):`, imageUrl);

      req.user.facebookPosts.push({
        url: postUrl,
        imageUrl: imageUrl,
        addedAt: new Date(),
      });
      await req.user.save();

      return res.status(200).json({
        success: true,
        platform: "facebook",
        url: postUrl,
        imageUrl: imageUrl,
        extractionMethod,
        message: "Facebook post image added successfully",
      });
    } catch (error) {
      console.error("Facebook scraping error:", error);
      return res.status(404).json({
        success: false,
        message:
          "Error accessing Facebook post. It may be private or not publicly accessible.",
        error: error.message,
      });
    }
  } catch (error) {
    console.error("Facebook API error:", error);
    return res.status(500).json({
      success: false,
      message: "Error fetching Facebook image",
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
        const thumbnailUrl = response.data.data.cover || "";
        const caption = response.data.data.title || "";
        const videoId = response.data.data.id || "";

        console.log("Successfully extracted TikTok thumbnail:", thumbnailUrl);
        console.log("Caption:", caption);

        // Save to user's profile
        req.user.tiktokPosts.push({
          url: videoUrl,
          thumbnailUrl: thumbnailUrl,
          caption: caption,
          videoId: videoId,
          addedAt: new Date(),
        });

        await req.user.save();

        return res.status(200).json({
          success: true,
          platform: "tiktok",
          url: videoUrl,
          thumbnailUrl: thumbnailUrl,
          caption: caption,
          videoId: videoId,
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

          // Save to user's profile
          req.user.tiktokPosts.push({
            url: videoUrl,
            thumbnailUrl: thumbnailUrl,
            caption: caption,
            addedAt: new Date(),
          });

          await req.user.save();

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

      // Still save the post with fallback image
      req.user.tiktokPosts.push({
        url: videoUrl,
        thumbnailUrl: fallbackThumbnail,
        addedAt: new Date(),
      });

      await req.user.save();

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
      !["Grid", "Carousel", "Masonry"].includes(value)
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

// Get posts by platform type
router.get("/:platform", protect, async (req, res) => {
  try {
    const user = req.user;
    const platform = req.params.platform.toLowerCase();

    // Check if platform is valid
    const validPlatforms = ["youtube", "tiktok", "instagram", "facebook"];
    if (!validPlatforms.includes(platform)) {
      return res.status(400).json({
        success: false,
        message:
          "Invalid platform. Must be youtube, tiktok, instagram, or facebook",
      });
    }

    // Get posts for the specified platform from user model
    let posts = [];
    switch (platform) {
      case "youtube":
        posts = user.youtubePosts;
        break;
      case "tiktok":
        posts = user.tiktokPosts;
        break;
      case "instagram":
        posts = user.instagramPosts;
        break;
      case "facebook":
        posts = user.facebookPosts;
        break;
    }

    return res.status(200).json({
      success: true,
      data: posts,
    });
  } catch (error) {
    console.error("Error fetching posts:", error);
    return res.status(500).json({
      success: false,
      message: "Error fetching posts",
      error: error.message,
    });
  }
});

// Get all posts based on selected platforms
router.get("/posts/all", protect, async (req, res) => {
  try {
    const user = req.user;
    const { selectedPlatforms, feedSettings } = user;
    const postsCount = parseInt(feedSettings?.postsCount || "6");

    let allPosts = [];

    // Get posts for each selected platform
    if (selectedPlatforms.youtube) {
      const youtubePosts = user.youtubePosts
        .filter((post) => post.selected)
        .map((post) => ({
          imageUrl: post.thumbnailUrl, // Map thumbnailUrl to imageUrl for consistency
          url: post.url,
          platform: "youtube",
        }));
      allPosts.push(...youtubePosts);
    }
    if (selectedPlatforms.tiktok) {
      const tiktokPosts = user.tiktokPosts
        .filter((post) => post.selected)
        .map((post) => ({
          imageUrl: post.thumbnailUrl, // Map thumbnailUrl to imageUrl for consistency
          url: post.url,
          platform: "tiktok",
        }));
      allPosts.push(...tiktokPosts);
    }
    if (selectedPlatforms.instagram) {
      const instagramPosts = user.instagramPosts
        .filter((post) => post.selected)
        .map((post) => ({
          imageUrl: post.imageUrl,
          url: post.url,
          platform: "instagram",
        }));
      allPosts.push(...instagramPosts);
    }
    if (selectedPlatforms.facebook) {
      const facebookPosts = user.facebookPosts
        .filter((post) => post.selected)
        .map((post) => ({
          imageUrl: post.imageUrl,
          url: post.url,
          platform: "facebook",
        }));
      allPosts.push(...facebookPosts);
    }

    // Sort posts by addedAt in descending order (newest first)
    allPosts.sort((a, b) => new Date(b.addedAt) - new Date(a.addedAt));

    // Take only the required number of posts
    allPosts = allPosts.slice(0, postsCount);

    // If we have fewer posts than required, fill with null posts
    while (allPosts.length < postsCount) {
      allPosts.push({
        url: null,
        imageUrl: null,
        platform: null,
        addedAt: null,
      });
    }
    console.log("ALL POSTS : ", allPosts);

    return res.status(200).json({
      success: true,
      posts: allPosts,
    });
  } catch (error) {
    console.error("Error fetching all posts:", error);
    return res.status(500).json({
      success: false,
      message: "Error fetching posts",
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

    const response = await axios({
      method: "get",
      url: url,
      responseType: "arraybuffer",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
        Referer: "https://www.instagram.com/",
        Accept: "image/webp,image/apng,image/*,*/*;q=0.8",
      },
      // Set longer timeout for large images
      timeout: 10000,
      maxRedirects: 5,
    });

    // Set appropriate headers
    const contentType = response.headers["content-type"] || "image/jpeg";
    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "public, max-age=86400"); // Cache for a day
    res.setHeader("Access-Control-Allow-Origin", "*"); // Allow cross-origin access

    // Send the image data
    res.send(response.data);
  } catch (error) {
    console.error("Image proxy error:", error.message);

    // If the error is related to the image not being found, return a 404
    if (error.response && error.response.status === 404) {
      return res.status(404).json({
        success: false,
        message: "Image not found",
        error: error.message,
      });
    }

    res.status(500).json({
      success: false,
      message: "Failed to fetch image",
      error: error.message,
    });
  }
});

// Select a post
router.post("/select", protect, async (req, res) => {
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
    let updated = false;
    let post = null;

    // Find and update the post based on platform
    switch (platform) {
      case "youtube":
        {
          const postIndex = user.youtubePosts.findIndex(
            (post) => post.url === url
          );
          if (postIndex !== -1) {
            user.youtubePosts[postIndex].selected = true;
            post = user.youtubePosts[postIndex];
            updated = true;
          }
        }
        break;

      case "tiktok":
        {
          const postIndex = user.tiktokPosts.findIndex(
            (post) => post.url === url
          );
          if (postIndex !== -1) {
            user.tiktokPosts[postIndex].selected = true;
            post = user.tiktokPosts[postIndex];
            updated = true;
          }
        }
        break;

      case "instagram":
        {
          const postIndex = user.instagramPosts.findIndex(
            (post) => post.url === url
          );
          if (postIndex !== -1) {
            user.instagramPosts[postIndex].selected = true;
            post = user.instagramPosts[postIndex];
            updated = true;
          }
        }
        break;

      case "facebook":
        {
          const postIndex = user.facebookPosts.findIndex(
            (post) => post.url === url
          );
          if (postIndex !== -1) {
            user.facebookPosts[postIndex].selected = true;
            post = user.facebookPosts[postIndex];
            updated = true;
          }
        }
        break;
    }

    if (updated) {
      await user.save();
      return res.status(200).json({
        success: true,
        message: `${platform} post selected successfully`,
        data: post,
      });
    } else {
      return res.status(404).json({
        success: false,
        message: `${platform} post not found with the provided URL`,
      });
    }
  } catch (error) {
    console.error("Select post error:", error);
    return res.status(500).json({
      success: false,
      message: "Error selecting post",
      error: error.message,
    });
  }
});

// Deselect a post
router.post("/deselect", protect, async (req, res) => {
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
    let updated = false;
    let post = null;

    // Find and update the post based on platform
    switch (platform) {
      case "youtube":
        {
          const postIndex = user.youtubePosts.findIndex(
            (post) => post.url === url
          );
          if (postIndex !== -1) {
            user.youtubePosts[postIndex].selected = false;
            post = user.youtubePosts[postIndex];
            updated = true;
          }
        }
        break;

      case "tiktok":
        {
          const postIndex = user.tiktokPosts.findIndex(
            (post) => post.url === url
          );
          if (postIndex !== -1) {
            user.tiktokPosts[postIndex].selected = false;
            post = user.tiktokPosts[postIndex];
            updated = true;
          }
        }
        break;

      case "instagram":
        {
          const postIndex = user.instagramPosts.findIndex(
            (post) => post.url === url
          );
          if (postIndex !== -1) {
            user.instagramPosts[postIndex].selected = false;
            post = user.instagramPosts[postIndex];
            updated = true;
          }
        }
        break;

      case "facebook":
        {
          const postIndex = user.facebookPosts.findIndex(
            (post) => post.url === url
          );
          if (postIndex !== -1) {
            user.facebookPosts[postIndex].selected = false;
            post = user.facebookPosts[postIndex];
            updated = true;
          }
        }
        break;
    }

    if (updated) {
      await user.save();
      return res.status(200).json({
        success: true,
        message: `${platform} post deselected successfully`,
        data: post,
      });
    } else {
      return res.status(404).json({
        success: false,
        message: `${platform} post not found with the provided URL`,
      });
    }
  } catch (error) {
    console.error("Deselect post error:", error);
    return res.status(500).json({
      success: false,
      message: "Error deselecting post",
      error: error.message,
    });
  }
});

// Get selected posts for a specific platform
router.get("/selected/:platform", protect, async (req, res) => {
  try {
    const { platform } = req.params;

    // Validate platform
    if (!["youtube", "tiktok", "instagram", "facebook"].includes(platform)) {
      return res.status(400).json({
        success: false,
        message:
          "Invalid platform. Must be youtube, tiktok, instagram, or facebook",
      });
    }

    const user = req.user;
    let selectedPosts = [];

    // Get selected posts based on platform
    switch (platform) {
      case "youtube":
        selectedPosts = user.youtubePosts.filter(
          (post) => post.selected === true
        );
        break;
      case "tiktok":
        selectedPosts = user.tiktokPosts.filter(
          (post) => post.selected === true
        );
        break;
      case "instagram":
        selectedPosts = user.instagramPosts.filter(
          (post) => post.selected === true
        );
        break;
      case "facebook":
        selectedPosts = user.facebookPosts.filter(
          (post) => post.selected === true
        );
        break;
    }

    // Sort posts by date, newest first
    selectedPosts.sort((a, b) => new Date(b.addedAt) - new Date(a.addedAt));

    return res.status(200).json({
      success: true,
      count: selectedPosts.length,
      platform: platform,
      data: selectedPosts,
    });
  } catch (error) {
    console.error(
      `Error fetching selected ${req.params.platform} posts:`,
      error
    );
    return res.status(500).json({
      success: false,
      message: `Error fetching selected ${req.params.platform} posts`,
      error: error.message,
    });
  }
});

// Get all selected posts from all platforms
router.get("/selected", protect, async (req, res) => {
  try {
    const user = req.user;

    // Get selected posts from each platform
    const youtubePosts = user.youtubePosts
      .filter((post) => post.selected === true)
      .map((post) => ({
        ...post.toObject(),
        platform: "youtube",
      }));

    const tiktokPosts = user.tiktokPosts
      .filter((post) => post.selected === true)
      .map((post) => ({
        ...post.toObject(),
        platform: "tiktok",
      }));

    const instagramPosts = user.instagramPosts
      .filter((post) => post.selected === true)
      .map((post) => ({
        ...post.toObject(),
        platform: "instagram",
      }));

    const facebookPosts = user.facebookPosts
      .filter((post) => post.selected === true)
      .map((post) => ({
        ...post.toObject(),
        platform: "facebook",
      }));

    // Combine all selected posts
    const allSelectedPosts = [
      ...youtubePosts,
      ...tiktokPosts,
      ...instagramPosts,
      ...facebookPosts,
    ];

    // Sort posts by date, newest first
    allSelectedPosts.sort((a, b) => new Date(b.addedAt) - new Date(a.addedAt));

    return res.status(200).json({
      success: true,
      count: allSelectedPosts.length,
      data: allSelectedPosts,
    });
  } catch (error) {
    console.error("Error fetching all selected posts:", error);
    return res.status(500).json({
      success: false,
      message: "Error fetching all selected posts",
      error: error.message,
    });
  }
});

module.exports = router;
