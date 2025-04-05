const Post = require("../models/Post");

exports.getPostCounts = async (req, res) => {
  try {
    const userId = req.user.id;

    // Get counts for each platform
    const [instagramCount, tiktokCount, facebookCount, youtubeCount] =
      await Promise.all([
        Post.countDocuments({ user: userId, platform: "instagram" }),
        Post.countDocuments({ user: userId, platform: "tiktok" }),
        Post.countDocuments({ user: userId, platform: "facebook" }),
        Post.countDocuments({ user: userId, platform: "youtube" }),
      ]);

    // Calculate total posts
    const totalPosts =
      instagramCount + tiktokCount + facebookCount + youtubeCount;

    res.json({
      success: true,
      data: {
        total: totalPosts,
        instagram: instagramCount,
        tiktok: tiktokCount,
        facebook: facebookCount,
        youtube: youtubeCount,
      },
    });
  } catch (error) {
    console.error("Error getting post counts:", error);
    res.status(500).json({
      success: false,
      message: "Error retrieving post counts",
    });
  }
};
