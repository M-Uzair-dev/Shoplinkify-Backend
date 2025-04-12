const express = require("express");
const router = express.Router();
const User = require("../models/User");
const Post = require("../models/Post");

// Get feed preview for a specific user
router.get("/:userId", async (req, res) => {
  try {
    const userId = req.params.userId;

    // Find user and their feed settings
    const user = await User.findById(userId).select(
      "mainHeading subHeading feedSettings selectedPlatforms"
    );

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    let platforms = [];
    if (user.selectedPlatforms?.instagram) platforms.push("instagram");
    if (user.selectedPlatforms?.facebook) platforms.push("facebook");
    if (user.selectedPlatforms?.youtube) platforms.push("youtube");
    if (user.selectedPlatforms?.tiktok) platforms.push("tiktok");

    const postsCount = parseInt(user.feedSettings?.postsCount || "6");

    const posts = await Post.find({
      user: user._id,
      platform: { $in: platforms },
      selected: true,
    })
      .sort({ addedAt: -1 })
      .limit(postsCount)
      .lean();

    console.log(posts);

    // Map posts to consistent format
    const formattedPosts = posts.map((post) => {
      let imageUrl = post.thumbnailUrl || post.imageUrl;
      return {
        imageUrl,
        url: post.url,
        platform: post.platform,
      };
    });

    res.json({
      success: true,
      feedSettings: {
        mainHeading: user.mainHeading || "Enter Main heading",
        subHeading: user.subHeading || "Enter Sub heading",
        layout: user.feedSettings?.layout || "Grid",
        postsCount: user.feedSettings?.postsCount || "6",
        platforms: user.selectedPlatforms || {
          instagram: false,
          facebook: false,
          tiktok: false,
          youtube: false,
        },
        posts: formattedPosts,
      },
    });
  } catch (error) {
    console.error("Error fetching feed preview:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching feed preview",
    });
  }
});

module.exports = router;
