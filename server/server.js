const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const jwt = require("jsonwebtoken");
const AWS = require("aws-sdk");
const bcrypt = require("bcrypt");
const path = require("path");

const app = express();
const port = process.env.PORT || 8080;

app.use((req, res, next) => {
  res.header(
    "Access-Control-Allow-Origin",
    "http://test-env.eba-ryprfkss.us-east-1.elasticbeanstalk.com"
  );
  res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  next();
});

app.use(cors());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.json());

app.use("/", express.static(path.join(__dirname, "..", "client")));

// Configure AWS DynamoDB
AWS.config.update({
  region: "us-east-1",
  accessKeyId: "AKIA2GSKERJERU6GFI4Y",
  secretAccessKey: "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",
});

// function to get user by ID
async function getUserByEmail(dynamoDB, email, usersTableName) {
  const params = {
    TableName: usersTableName,
    Key: {
      email: email,
    },
  };
  const result = await dynamoDB.get(params).promise();
  return result.Item;
}

// Function to save user to DynamoDB
async function saveUserToDynamoDB(
  dynamoDB,
  firstName,
  lastName,
  address,
  email,
  password,
  usersTableName
) {
  const params = {
    TableName: usersTableName,
    Item: {
      firstName: firstName,
      lastName: lastName,
      address: address,
      email: email,
      password: password,
    },
  };

  await dynamoDB.put(params).promise();
}

// Function to book gas
async function bookGas(
  dynamoDB,
  email,
  address,
  gasBookingTableName,
  days,
  IndexName
) {
  try {
    const bookingDate = new Date().toISOString().split('T')[0];
    const booking = {
      bookingDate: bookingDate,
      email: email,
      address: address,
      days: days
    };
    await saveGasBookingToDynamoDB(dynamoDB, booking, gasBookingTableName);
    return "Gas booking created successfully!";
  } catch (error) {
    console.error("Error during gas booking:", error);
    throw new Error("Failed to book gas. " + error.message);
  }
}

// Function to get the most recent booking
async function getRecentBooking(
  dynamoDB,
  email,
  startDate,
  gasBookingTableName,
  IndexName
) {
  const params = {
    TableName: gasBookingTableName,
    IndexName: IndexName,
    KeyConditionExpression: "email = :email AND bookingDate >= :startDate",
    ExpressionAttributeValues: {
      ":email": email,
      ":startDate": startDate,
    },
    ScanIndexForward: false,
    Limit: 1,
  };

  const result = await dynamoDB.query(params).promise();

  return result.Items.length > 0 ? result.Items[0] : null;
}

// Function to save gas booking to DynamoDB
async function saveGasBookingToDynamoDB(
  dynamoDB,
  booking,
  gasBookingTableName
) {
  const params = {
    TableName: gasBookingTableName,
    Item: booking,
  };

  await dynamoDB.put(params).promise();
}

// Function to view all user bookings
async function viewAllBookings(
  dynamoDB,
  email,
  gasBookingTableName,
  IndexName
) {
  const params = {
    TableName: gasBookingTableName,
    IndexName: IndexName,
    KeyConditionExpression: "email = :email",
    ExpressionAttributeValues: {
      ":email": email,
    },
    ScanIndexForward: false,
  };

  const result = await dynamoDB.query(params).promise();

  return result.Items;
}

// Function to update user address
async function updateAddress(
  dynamoDB,
  email,
  newAddress,
  gasBookingTableName,
  IndexName
) {
  try {
    const latestBooking = await getRecentBooking(
      dynamoDB,
      email,
      "1970-01-01T00:00:00.000Z",
      gasBookingTableName,
      IndexName
    );

    if (!latestBooking) {
      throw new Error("No booking found to edit Address.");
    }

    const currentDateTime = new Date();
    const bookingDateTime = new Date(latestBooking.bookingDate);
    const hoursDifference = Math.abs(currentDateTime - bookingDateTime) / 36e5;

    if (hoursDifference > 24) {
      throw new Error(
        "Cannot edit booking address after 24 hours of booking date-time."
      );
    }

    console.log("Updating Address to:", newAddress);

    await dynamoDB
      .update({
        TableName: gasBookingTableName,
        Key: {
          email: email,
          bookingDate: latestBooking.bookingDate,
        },
        UpdateExpression: "SET #address = :newAddress",
        ExpressionAttributeNames: {
          "#address": "address",
        },
        ExpressionAttributeValues: {
          ":newAddress": newAddress,
        },
      })
      .promise();

    console.log("Address Updated successfully!");
    return "Address Updated successfully!";
  } catch (error) {
    console.error("Error during updating address:", error);
    throw new Error("Failed to update address " + error.message);
  }
}

// Function to cancel the most recent booking
async function cancelBooking(dynamoDB, email, gasBookingTableName, IndexName) {
  try {
    const latestBooking = await getRecentBooking(
      dynamoDB,
      email,
      "1970-01-01T00:00:00.000Z",
      gasBookingTableName,
      IndexName
    );

    if (!latestBooking) {
      throw new Error("No booking found to cancel.");
    }

    // Check if the booking is within the last 24 hours
    const currentDateTime = new Date();
    const bookingDateTime = new Date(latestBooking.bookingDate);
    const hoursDifference = Math.abs(currentDateTime - bookingDateTime) / 36e5;

    if (hoursDifference > 24) {
      throw new Error(
        "Cannot cancel a booking after 24 hours of booking date-time."
      );
    }

    // Proceed with cancellation
    await dynamoDB
      .delete({
        TableName: gasBookingTableName,
        Key: {
          email: email,
          bookingDate: latestBooking.bookingDate,
        },
      })
      .promise();

    return "Booking canceled successfully!";
  } catch (error) {
    console.error("Error during canceling booking:", error);
    throw new Error("Failed to cancel booking. " + error.message);
  }
}

const dynamoDB = new AWS.DynamoDB.DocumentClient();
const gasBookingTableName = "GasBookings";
const usersTableName = "Users";
const jwtSecret = "your_jwt_secret";
const IndexName = "email-bookingDate-index";

// Middleware to verify JWT token
const verifyToken = (req, res, next) => {
  const token = req.headers.authorization;

  if (!token) {
    return res.status(403).json({ error: "Token not provided" });
  }

  jwt.verify(token, jwtSecret, (err, decoded) => {
    if (err) {
      return res.status(401).json({ error: "Failed to authenticate token" });
    }
    req.user = decoded;
    next();
  });
};

// Endpoint to get background image
app.get("/room1", (req, res) => {
  const imageUrl = "./room1.jpg";
  res.json({ imageUrl });
});
app.get("/room2", (req, res) => {
  const imageUrl = "./room2.jpeg";
  res.json({ imageUrl });
});
app.get("/room3", (req, res) => {
  const imageUrl = "./room3.jpeg";
  res.json({ imageUrl });
});
app.get("/bg", (req, res) => {
  const imageUrl = "./bg.jpg";
  res.json({ imageUrl });
});

// Endpoint for user signup
app.post("/signup", async (req, res) => {
  try {
    const { firstName, lastName, address, email, password } = req.body;

    // Check if the user already exists
    const existingUser = await getUserByEmail(dynamoDB, email, usersTableName);

    if (existingUser) {
      return res.status(400).json({
        error: "Email already exists. Please choose a different email.",
      });
    }

    // Hash the password before storing it
    const hashedPassword = await bcrypt.hash(password, 12);

    // Save the user to DynamoDB
    await saveUserToDynamoDB(
      dynamoDB,
      firstName,
      lastName,
      address,
      email,
      hashedPassword,
      usersTableName
    );

    res.json({ message: "User signup successful!" });
  } catch (error) {
    console.error("Error during user signup:", error);
    res.status(500).json({ error: "Failed to perform user signup." });
  }
});

// Endpoint for user login
app.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    // Retrieve user from DynamoDB based on email
    const user = await getUserByEmail(dynamoDB, email, usersTableName);

    if (!user) {
      return res.status(401).json({ error: "Invalid email or password" });
    }

    // Compare the provided password with the stored hashed password
    const passwordMatch = await bcrypt.compare(password, user.password);

    if (passwordMatch) {
      const token = jwt.sign({ email: user.email }, jwtSecret, {
        expiresIn: "1h",
      });
      res.json({ message: "User login successful!", token });
    } else {
      res.status(401).json({ error: "Invalid email or password" });
    }
  } catch (error) {
    console.error("Error during user login:", error);
    res.status(500).json({ error: "Failed to perform user login." });
  }
});

// Endpoint for gas booking
app.post("/book-gas", verifyToken, async (req, res) => {
  try {
    const userEmail = req.user.email;
    const address = req.body.roomType;
    const days = req.body.days;

    const message = await bookGas(
      dynamoDB,
      userEmail,
      address,
      gasBookingTableName,
      days,
      IndexName
    );
    res.json({ message });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Endpoint to view all user bookings
app.get("/user-bookings", verifyToken, async (req, res) => {
  try {
    const email = req.user.email;

    const bookings = await viewAllBookings(
      dynamoDB,
      email,
      gasBookingTableName,
      IndexName
    );
    res.json(bookings);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Endpoint to update user address
app.put("/update-address", verifyToken, async (req, res) => {
  try {
    const email = req.user.email;
    const address = req.body.updatedAddress;

    const response = await updateAddress(
      dynamoDB,
      email,
      address,
      gasBookingTableName,
      IndexName
    );
    res.json(response);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Endpoint to cancel the most recent booking
app.delete("/cancel-recent-booking", verifyToken, async (req, res) => {
  try {
    const email = req.user.email;
    const response = await cancelBooking(
      dynamoDB,
      email,
      gasBookingTableName,
      IndexName
    );
    res.json(response);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.use("*", (_, res) => res.redirect("/login.html"));

// Start the server
app.listen(port, "0.0.0.0", () => {
  console.log(`Server is running on port ${port}`);
});
