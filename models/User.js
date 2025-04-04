const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");

const userSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, "Please provide a name"],
      trim: true,
      maxlength: [50, "Name cannot be more than 50 characters"],
    },
    email: {
      type: String,
      required: [true, "Please provide an email"],
      unique: true,
      match: [
        /^(([^<>()[\]\\.,;:\s@"]+(\.[^<>()[\]\\.,;:\s@"]+)*)|(".+"))@((\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\])|(([a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,}))$/,
        "Please provide a valid email",
      ],
    },
    profileImage: {
      type: String,
      default: null,
    },
    password: {
      type: String,
      required: [true, "Please provide a password"],
      minlength: [6, "Password must be at least 6 characters"],
      select: false,
    },
    selectedPlatforms: {
      type: {
        instagram: {
          type: Boolean,
          default: true,
        },
        facebook: {
          type: Boolean,
          default: true,
        },
        youtube: {
          type: Boolean,
          default: true,
        },
        tiktok: {
          type: Boolean,
          default: true,
        },
      },
      default: () => ({
        instagram: true,
        facebook: true,
        youtube: true,
        tiktok: true,
      }),
    },
    feedSettings: {
      layout: {
        type: String,
        enum: ["Grid", "No Gutter", "Highlight", "Slideshow"],
        default: "Grid",
      },
      postsCount: {
        type: String,
        enum: ["3", "6", "9", "12", "15"],
        default: "6",
      },
    },
    youtubePosts: {
      type: [
        {
          url: String,
          embedCode: String,
          videoId: String,
          thumbnailUrl: String,
          title: String,
          channelName: String,
          channelImage: String,
          description: String,
          productLink: String,
          selected: {
            type: Boolean,
            default: false,
          },
          addedAt: {
            type: Date,
            default: Date.now,
          },
        },
      ],
      default: [],
    },
    tiktokPosts: {
      type: [
        {
          url: String,
          thumbnailUrl: String,
          caption: String,
          videoId: String,
          username: String,
          userImage: String,
          videoPath: String,
          title: String,
          description: String,
          productLink: String,
          selected: {
            type: Boolean,
            default: false,
          },
          addedAt: {
            type: Date,
            default: Date.now,
          },
        },
      ],
      default: [],
    },
    instagramPosts: {
      type: [
        {
          url: String,
          imageUrl: String,
          embedCode: String,
          title: String,
          description: String,
          productLink: String,
          selected: {
            type: Boolean,
            default: false,
          },
          addedAt: {
            type: Date,
            default: Date.now,
          },
        },
      ],
      default: [],
    },
    facebookPosts: {
      type: [
        {
          url: String,
          imageUrl: String,
          title: String,
          description: String,
          productLink: String,
          selected: {
            type: Boolean,
            default: false,
          },
          addedAt: {
            type: Date,
            default: Date.now,
          },
        },
      ],
      default: [],
    },
    // Legacy fields for backward compatibility
    youtubeEmbeds: {
      type: [String],
      default: [],
    },
    tiktokEmbeds: {
      type: [String],
      default: [],
    },
    createdAt: {
      type: Date,
      default: Date.now,
    },
    resetPasswordToken: String,
    resetPasswordExpire: Date,
  },
  {
    timestamps: true,
  }
);

userSchema.pre("save", async function (next) {
  if (!this.isModified("password")) {
    next();
  }
  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
});

userSchema.pre("findOneAndUpdate", async function (next) {
  if (this._update.password) {
    this._update.password = await bcrypt.hash(this._update.password, 10);
  }
  next();
});

userSchema.methods.getSignedJwtToken = function () {
  return jwt.sign({ id: this._id }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRE,
  });
};

userSchema.methods.matchPassword = async function (enteredPassword) {
  return await bcrypt.compare(enteredPassword, this.password);
};

userSchema.methods.getResetPasswordToken = function () {
  // Generate token
  const resetToken = crypto.randomBytes(20).toString("hex");

  // Hash token and set to resetPasswordToken field
  this.resetPasswordToken = crypto
    .createHash("sha256")
    .update(resetToken)
    .digest("hex");

  // Set expire to 5 minutes
  this.resetPasswordExpire = Date.now() + 5 * 60 * 1000;

  return resetToken;
};

module.exports = mongoose.model("User", userSchema);
