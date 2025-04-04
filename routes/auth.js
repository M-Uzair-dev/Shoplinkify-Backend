const express = require("express");
const router = express.Router();
const { body, check } = require("express-validator");
const {
  register,
  login,
  getMe,
  forgotPassword,
  resetPassword,
} = require("../controllers/authController");
const { protect } = require("../middleware/auth");

router.post(
  "/register",

  [
    body("name").notEmpty().withMessage("Name is required"),
    body("email").isEmail().withMessage("Please include a valid email"),
    body("password")
      .isLength({ min: 6 })
      .withMessage("Password must be at least 6 characters"),
  ],
  register
);

router.post(
  "/login",
  [
    body("email").isEmail().withMessage("Please include a valid email"),
    body("password").exists().withMessage("Password is required"),
  ],
  login
);

router.get("/me", protect, getMe);

// @route   POST api/auth/forgot-password
// @desc    Forgot password
// @access  Public
router.post(
  "/forgot-password",
  [check("email", "Please include a valid email").isEmail()],
  forgotPassword
);

// @route   PUT api/auth/reset-password/:resettoken
// @desc    Reset password
// @access  Public
router.put(
  "/reset-password/:resettoken",
  [
    check(
      "password",
      "Please enter a password with 6 or more characters"
    ).isLength({ min: 6 }),
  ],
  resetPassword
);

module.exports = router;
