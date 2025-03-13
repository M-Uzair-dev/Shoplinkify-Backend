const express = require("express");
const router = express.Router();
const { body } = require("express-validator");
const { protect } = require("../middleware/auth");
const { updateUser, deleteUser } = require("../controllers/userController");

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

module.exports = router;
