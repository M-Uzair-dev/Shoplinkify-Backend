const cloudinary = require("cloudinary").v2;
const dotenv = require("dotenv");

// Load environment variables
dotenv.config();

// Configure Cloudinary
cloudinary.config({
  cloud_name: "dexeo4ce2",
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const uploadFile = async (image, setUploading) => {
  // Handle case where setUploading might be undefined/null
  setUploading = typeof setUploading === "function" ? setUploading : () => {};

  setUploading(true);

  // Check if environment variables are properly set
  if (!process.env.CLOUDINARY_API_KEY || !process.env.CLOUDINARY_API_SECRET) {
    console.error(
      "❌ ERROR: Cloudinary credentials are missing in environment variables!"
    );
    setUploading(false);
    throw new Error(
      "Cloudinary configuration is incomplete. Check your environment variables."
    );
  }

  console.log("📝 Cloudinary Config Check:");
  console.log("  ☁️ Cloud Name: dexeo4ce2");
  console.log("  🔑 API Key Available:", !!process.env.CLOUDINARY_API_KEY);
  console.log(
    "  🔒 API Secret Available:",
    !!process.env.CLOUDINARY_API_SECRET
  );

  try {
    let result;

    if (Buffer.isBuffer(image)) {
      console.log(
        "⬆️ Uploading to Cloudinary from buffer (size: " +
          image.length +
          " bytes)"
      );

      // Upload buffer
      result = await new Promise((resolve, reject) => {
        const uploadStream = cloudinary.uploader.upload_stream(
          {
            resource_type: "auto",
            folder: "shoplinkify",
            timeout: 60000, // 60 second timeout for larger images
          },
          (error, result) => {
            if (error) {
              console.error("❌ Cloudinary streaming upload error:", error);
              reject(error);
            } else {
              console.log("✅ Cloudinary streaming upload complete");
              resolve(result);
            }
          }
        );

        try {
          uploadStream.end(image);
        } catch (streamError) {
          console.error("❌ Stream error:", streamError);
          reject(streamError);
        }
      });
    } else {
      // Validate if it's a URL or file path
      const isUrl =
        typeof image === "string" &&
        (image.startsWith("http://") ||
          image.startsWith("https://") ||
          image.startsWith("data:"));

      if (isUrl) {
        console.log(
          "⬆️ Uploading to Cloudinary from URL:",
          image.substring(0, 100) + (image.length > 100 ? "..." : "")
        );
      } else {
        console.log("⬆️ Uploading to Cloudinary from file path");
      }

      // Upload from URL or file path
      result = await cloudinary.uploader.upload(image, {
        resource_type: "auto",
        folder: "shoplinkify",
        timeout: 60000, // 60 second timeout
        fetch_format: "auto",
        quality: "auto",
      });
    }

    console.log("✅ Cloudinary upload result:", {
      public_id: result.public_id,
      format: result.format,
      resource_type: result.resource_type,
      secure_url: result.secure_url,
      created_at: result.created_at,
      bytes: result.bytes,
      width: result.width,
      height: result.height,
    });

    setUploading(false);
    return result.secure_url;
  } catch (error) {
    console.error("❌ Cloudinary upload error:", error);

    // Check for specific error types and provide clearer messages
    if (error.http_code === 401) {
      console.error(
        "❌ Authentication error: Check your Cloudinary API key and secret"
      );
    } else if (error.http_code === 403) {
      console.error(
        "❌ Authorization error: Your account may not have permission to upload"
      );
    } else if (error.http_code === 420 || error.http_code === 429) {
      console.error("❌ Rate limit exceeded: Too many requests to Cloudinary");
    } else if (error.http_code >= 500) {
      console.error("❌ Cloudinary server error: Try again later");
    }

    // If there's a response in the error, log it for debugging
    if (error.response) {
      console.error("Error details:", error.response.data || error.response);
    }

    setUploading(false);
    throw error;
  }
};

module.exports = uploadFile;
