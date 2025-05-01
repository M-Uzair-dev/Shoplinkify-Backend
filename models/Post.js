const mongoose = require("mongoose");

const postSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    platform: {
      type: String,
      enum: ["youtube", "tiktok", "instagram", "facebook"],
      required: true,
    },
    url: {
      type: String,
      required: true,
    },
    // Common fields for all platforms
    title: {
      type: String,
      default: "",
    },
    description: {
      type: String,
      default: "",
    },
    productLink: {
      type: String,
      default: "",
    },
    selected: {
      type: Boolean,
      default: true,
    },
    // Platform specific fields
    // YouTube specific
    videoId: String,
    embedCode: String,
    thumbnailUrl: String,
    channelName: String,
    channelImage: String,
    // TikTok specific
    caption: String,
    username: String,
    userImage: String,
    videoPath: String,
    // Instagram specific
    imageUrl: String,
    // Facebook specific
    // No additional fields needed
    addedAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: true,
  }
);

// Create a compound index for user and url to ensure uniqueness
postSchema.index({ user: 1, url: 1 }, { unique: true });

module.exports = mongoose.model("Post", postSchema);
