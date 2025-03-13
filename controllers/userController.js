const User = require("../models/User");
const { validationResult } = require("express-validator");

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
