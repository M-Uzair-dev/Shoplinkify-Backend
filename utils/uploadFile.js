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
  setUploading(true);
  console.log("API KEY : ", process.env.CLOUDINARY_API_KEY);
  console.log("API SECRET : ", process.env.CLOUDINARY_API_SECRET);
  try {
    let result;

    if (Buffer.isBuffer(image)) {
      // Upload buffer
      result = await new Promise((resolve, reject) => {
        cloudinary.uploader
          .upload_stream({ resource_type: "auto" }, (error, result) => {
            if (error) reject(error);
            else resolve(result);
          })
          .end(image);
      });
    } else {
      // Upload from URL or file path
      result = await cloudinary.uploader.upload(image, {
        resource_type: "auto",
      });
    }

    console.log("Cloudinary upload result:", result);
    return result.secure_url;
  } catch (error) {
    console.error("Cloudinary upload error:", error);
    throw error;
  } finally {
    setUploading(false);
  }
};

module.exports = uploadFile;
