const { validationResult } = require("express-validator");
const User = require("../models/User");

exports.register = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    let user = req.user;
    if (user) {
      return res.status(400).json({ message: "User already exists" });
    }

    user = new User({
      name: req.body.name,
      email: req.body.email,
      password: req.body.password,
    });

    await user.save();

    const token = user.getSignedJwtToken();

    res.status(201).json({
      success: true,
      token,
      user
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
};

exports.login = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { email, password } = req.body;

    const user = await User.findOne({ email }).select("+password");
    if (!user) {
      return res.status(401).json({ message: "Invalid credentials" });
    }

    const isMatch = await user.matchPassword(password);
    if (!isMatch) {
      return res.status(401).json({ message: "Invalid credentials" });
    }

    const token = user.getSignedJwtToken();

    res.json({
      success: true,
      token,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
};

exports.getMe = async (req, res) => {
  try {
    const user = req.user;
    res.json(user);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
};
