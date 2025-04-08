const mongoose = require("mongoose");

const clickSchema = new mongoose.Schema(
  {
    country: {
      type: String,
      required: true,
      trim: true,
    },
    post: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Post",
      required: true,
    },
    platform: {
      type: String,
      enum: ["instagram", "facebook", "tiktok", "youtube"],
      required: true,
    },
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    date: {
      type: Date,
      default: Date.now,
    },
    device: {
      type: String,
      enum: ["desktop", "mobile"],
      default: "desktop",
    },
  },
  {
    timestamps: true,
  }
);

// Add index for common queries
clickSchema.index({ postId: 1, date: -1 });
clickSchema.index({ user: 1, date: -1 });

module.exports = mongoose.model("Click", clickSchema);
