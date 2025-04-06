const User = require("../models/User");
const { validationResult } = require("express-validator");
const Post = require("../models/Post");

exports.updateUser = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const user = req.user;
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    const updateFields = {
      name: req.body.name || user.name,
      email: req.body.email || user.email,
    };

    if (req.body.password) {
      user.password = req.body.password;
      await user.save();
    }

    const updatedUser = await User.findByIdAndUpdate(
      user._id,
      { $set: updateFields },
      { new: true, runValidators: true }
    ).select("-password");

    res.json(updatedUser);
  } catch (err) {
    console.error(err);
    if (err.kind === "ObjectId") {
      return res.status(404).json({ message: "User not found" });
    }
    res.status(500).json({ message: "Server error" });
  }
};

exports.deleteUser = async (req, res) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    if (user._id.toString() !== req.user.id) {
      return res
        .status(401)
        .json({ message: "Not authorized to delete this user" });
    }

    await user.deleteOne();
    res.json({ message: "User removed" });
  } catch (err) {
    console.error(err);
    if (err.kind === "ObjectId") {
      return res.status(404).json({ message: "User not found" });
    }
    res.status(500).json({ message: "Server error" });
  }
};

exports.updateProfile = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const user = req.user;
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    const updateFields = {};

    // Only update name if provided
    if (req.body.name) {
      updateFields.name = req.body.name;
    }

    // Only update profileImage if provided
    if (req.body.profileImage) {
      updateFields.profileImage = req.body.profileImage;
    }

    const updatedUser = await User.findByIdAndUpdate(
      user._id,
      { $set: updateFields },
      { new: true, runValidators: true }
    ).select("-password");

    res.json(updatedUser);
  } catch (err) {
    console.error(err);
    if (err.kind === "ObjectId") {
      return res.status(404).json({ message: "User not found" });
    }
    res.status(500).json({ message: "Server error" });
  }
};

exports.changePassword = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const user = await User.findById(req.user.id).select("+password");
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    // Check current password
    const isMatch = await user.matchPassword(req.body.currentPassword);
    if (!isMatch) {
      return res.status(500).json({ message: "Current password is incorrect" });
    }

    // Update password
    user.password = req.body.newPassword;
    await user.save();

    res.json({ message: "Password updated successfully" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
};

exports.deleteAccount = async (req, res) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    await user.deleteOne();
    res.json({ message: "Account deleted successfully" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
};

exports.getName = async (req, res) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    res.json({ name: user.name });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
};

exports.getPostCounts = async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    // Get counts from Post model
    const [youtubeCount, tiktokCount, instagramCount, facebookCount] =
      await Promise.all([
        Post.countDocuments({ user: req.user.id, platform: "youtube" }),
        Post.countDocuments({ user: req.user.id, platform: "tiktok" }),
        Post.countDocuments({ user: req.user.id, platform: "instagram" }),
        Post.countDocuments({ user: req.user.id, platform: "facebook" }),
      ]);

    const counts = {
      total: youtubeCount + tiktokCount + instagramCount + facebookCount,
      instagram: instagramCount,
      tiktok: tiktokCount,
      facebook: facebookCount,
      youtube: youtubeCount,
    };

    res.json({
      success: true,
      data: counts,
    });
  } catch (error) {
    console.error("Error getting post counts:", error);
    res.status(500).json({
      success: false,
      message: "Error retrieving post counts",
    });
  }
};

exports.updateHeadings = async (req, res) => {
  try {
    const { mainHeading, subHeading } = req.body;
    const user = req.user;

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    const updateFields = {};
    if (mainHeading !== undefined) updateFields.mainHeading = mainHeading;
    if (subHeading !== undefined) updateFields.subHeading = subHeading;

    const updatedUser = await User.findByIdAndUpdate(
      user._id,
      { $set: updateFields },
      { new: true }
    );

    res.json({
      success: true,
      data: {
        mainHeading: updatedUser.mainHeading,
        subHeading: updatedUser.subHeading,
      },
    });
  } catch (error) {
    console.error("Error updating headings:", error);
    res.status(500).json({
      success: false,
      message: "Error updating headings",
    });
  }
};
