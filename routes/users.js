const express = require("express");
const router = express.Router();
const { body } = require("express-validator");
const { protect } = require("../middleware/auth");
const {
  updateUser,
  deleteUser,
  updateProfile,
  changePassword,
  deleteAccount,
  getName,
  getPostCounts,
  updateHeadings,
} = require("../controllers/userController");

// Get user's name
router.get("/name", protect, getName);
router.get("/counts", protect, getPostCounts);

// Update profile (name and image)
router.patch(
  "/profile",
  protect,
  [
    body("name")
      .optional()
      .notEmpty()
      .withMessage("Name is required")
      .isLength({ max: 50 })
      .withMessage("Name cannot be more than 50 characters"),
    body("profileImage")
      .optional()
      .isURL()
      .withMessage("Please provide a valid image URL"),
  ],
  updateProfile
);

// Change password
router.patch(
  "/password",
  protect,
  [
    body("currentPassword")
      .notEmpty()
      .withMessage("Current password is required"),
    body("newPassword")
      .notEmpty()
      .withMessage("New password is required")
      .isLength({ min: 6 })
      .withMessage("Password must be at least 6 characters"),
  ],
  changePassword
);

// Delete account
router.delete("/account", protect, deleteAccount);

// Legacy routes
router.delete("/", protect, deleteUser);
router.patch(
  "/",
  protect,
  [
    body("name")
      .optional()
      .notEmpty()
      .withMessage("Name is required")
      .isLength({ max: 50 })
      .withMessage("Name cannot be more than 50 characters"),
    body("email")
      .optional()
      .isEmail()
      .withMessage("Please include a valid email"),
  ],
  updateUser
);

// @route   GET /api/users/headings
// @desc    Get user's headings
router.get("/headings", protect, async (req, res) => {
  try {
    const user = await req.user;
    res.json({
      success: true,
      data: {
        mainHeading: user.mainHeading,
        subHeading: user.subHeading,
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Error retrieving headings",
    });
  }
});

// @route   POST /api/users/headings
// @desc    Update user's headings
router.post("/headings", protect, updateHeadings);

module.exports = router;
