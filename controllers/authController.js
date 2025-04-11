const { validationResult } = require("express-validator");
const User = require("../models/User");
const sendEmail = require("../utils/sendEmail");
const crypto = require("crypto");

exports.register = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    let user = await User.findOne({ email: req.body.email });
    console.log(user);
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
      user,
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

exports.forgotPassword = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const user = await User.findOne({ email: req.body.email });

    if (!user) {
      return res
        .status(404)
        .json({ message: "There is no user with that email" });
    }

    // Get reset token
    const resetToken = user.getResetPasswordToken();
    await user.save({ validateBeforeSave: false });

    // Create reset url
    const resetUrl = `${process.env.FRONTEND_URL}/reset-password/${resetToken}`;

    try {
      await sendEmail({
        email: user.email,
        subject: "Shoplinkify Password Reset Request",
        message: `Hello ${user.name},\n\nYou recently requested to reset your password for your Shoplinkify account. Click the link below to reset it:\n\n${resetUrl}\n\nThis password reset link is only valid for the next 5 minutes.\n\nIf you did not request this reset, please ignore this email and your password will remain unchanged.\n\nBest regards,\nThe Shoplinkify Team`,
        html: `
          <div style="background-color: #f7f7f7; padding: 20px; font-family: Arial, sans-serif;">
            <div style="max-width: 600px; margin: 0 auto; background-color: white; padding: 30px; border-radius: 14px; border: 1px solid #fceced;">
              <div style="text-align: center; margin-bottom: 30px;">
                <h1 style="color: #1a1a1a; font-size: 28px; margin: 0;">Shoplinkify</h1>
                <div style="width: 40px; height: 3px; background: #fceced; margin: 10px auto; border-radius: 7px;"></div>
              </div>
              
              <h2 style="color: #1a1a1a; font-size: 20px; margin-bottom: 20px;">Password Reset Request</h2>
              
              <p style="color: #666; font-size: 16px; line-height: 1.5; margin-bottom: 20px;">
                Hello ${user.name},
              </p>
              
              <p style="color: #666; font-size: 16px; line-height: 1.5; margin-bottom: 20px;">
                You recently requested to reset your password for your Shoplinkify account. Click the button below to reset it:
              </p>
              
              <div style="text-align: center; margin: 30px 0;">
                <a href="${resetUrl}" 
                   style="display: inline-block; padding: 16px 30px; background-color: #1a1a1a; color: white; text-decoration: none; border-radius: 14px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; font-size: 14px;">
                  Reset Password
                </a>
              </div>
              
              <p style="color: #666; font-size: 14px; line-height: 1.5; margin-bottom: 20px;">
                This password reset link is only valid for the next 5 minutes.
              </p>
              
              <p style="color: #666; font-size: 14px; line-height: 1.5; margin-bottom: 20px;">
                If you did not request this reset, please ignore this email and your password will remain unchanged.
              </p>
              
              <div style="border-top: 1px solid #fceced; margin-top: 30px; padding-top: 20px;">
                <p style="color: #666; font-size: 14px; line-height: 1.5; margin: 0; text-align: center;">
                  Best regards,<br>
                  The Shoplinkify Team
                </p>
              </div>
            </div>
          </div>
        `,
      });

      res.json({ message: "Email sent" });
    } catch (err) {
      console.error(err);
      user.resetPasswordToken = undefined;
      user.resetPasswordExpire = undefined;
      await user.save({ validateBeforeSave: false });

      return res.status(500).json({ message: "Email could not be sent" });
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
};

exports.resetPassword = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    // Get hashed token
    const resetPasswordToken = crypto
      .createHash("sha256")
      .update(req.params.resettoken)
      .digest("hex");

    const user = await User.findOne({
      resetPasswordToken,
      resetPasswordExpire: { $gt: Date.now() },
    });

    if (!user) {
      return res.status(400).json({ message: "Invalid or expired token" });
    }

    // Set new password
    user.password = req.body.password;
    user.resetPasswordToken = undefined;
    user.resetPasswordExpire = undefined;
    await user.save();

    res.json({ message: "Password reset successful" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
};
exports.userCount = async (req, res) => {
  const userCount = await User.countDocuments();
  res.json({ userCount });
};
