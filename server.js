const express = require("express");
const session = require("express-session");
const mysql = require("mysql2/promise");
const path = require("path");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 5000;

app.use(express.json());

if (!process.env.SESSION_SECRET ||
    !process.env.ADMIN_USERNAME ||
    !process.env.ADMIN_PASSWORD) {
    console.error("Missing admin/session settings in .env");
    process.exit(1);
}

app.use(session({
    name: "aquapure.sid",
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
        httpOnly: true,
        sameSite: "lax",
        secure: false,
        maxAge: 1000 * 60 * 60 * 8
    }
}));

const db = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 10
});

// ==================== ADMIN LOGIN ====================

app.post("/api/login", (req, res) => {
    const { username, password } = req.body || {};

    if (
        typeof username !== "string" ||
        typeof password !== "string" ||
        username !== process.env.ADMIN_USERNAME ||
        password !== process.env.ADMIN_PASSWORD
    ) {
        return res.status(401).json({
            success: false,
            message: "Invalid username or password"
        });
    }

    req.session.regenerate((err) => {
        if (err) {
            console.error("Session error:", err.message);
            return res.status(500).json({
                success: false,
                message: "Could not start login session"
            });
        }

        req.session.isAdmin = true;

        req.session.save((saveError) => {
            if (saveError) {
                console.error("Session save error:", saveError.message);
                return res.status(500).json({
                    success: false,
                    message: "Could not save login session"
                });
            }

            res.json({
                success: true,
                message: "Login successful"
            });
        });
    });
});

app.post("/api/logout", (req, res) => {
    req.session.destroy((err) => {
        if (err) {
            return res.status(500).json({
                success: false,
                message: "Logout failed"
            });
        }

        res.clearCookie("aquapure.sid", {
            httpOnly: true,
            sameSite: "lax",
            secure: false
        });

        res.json({
            success: true,
            message: "Logged out"
        });
    });
});

app.get("/api/auth-status", (req, res) => {
    res.json({
        loggedIn: Boolean(req.session && req.session.isAdmin)
    });
});

// ==================== HOME PAGE ====================

app.get("/", (req, res) => {
    if (req.session && req.session.isAdmin) {
        return res.sendFile(
            path.join(__dirname, "public", "index.html")
        );
    }

    res.redirect("/login.html");
});

// ==================== PROTECT ALL OTHER APIs ====================

app.use("/api", (req, res, next) => {
    if (req.session && req.session.isAdmin) {
        return next();
    }

    res.status(401).json({
        success: false,
        message: "Please log in as admin"
    });
});

// ==================== DATABASE TEST ====================

app.get("/api/test-db", async (req, res) => {
    try {
        await db.query("SELECT 1");

        res.json({
            success: true,
            message: "MySQL connected successfully!"
        });
    } catch (error) {
        console.error("Database error:", error.message);

        res.status(500).json({
            success: false,
            message: "Database connection failed"
        });
    }
});

// ==================== ADD CUSTOMER ====================

app.post("/api/customers", async (req, res) => {
    try {
        const { name, phone, address } = req.body || {};

        if (
            typeof name !== "string" || !name.trim() ||
            typeof phone !== "string" || !phone.trim()
        ) {
            return res.status(400).json({
                success: false,
                message: "Name and phone are required"
            });
        }

        const [result] = await db.execute(
            "INSERT INTO customers (name, phone, address) VALUES (?, ?, ?)",
            [name.trim(), phone.trim(),
             typeof address === "string" ? address.trim() || null : null]
        );

        res.status(201).json({
            success: true,
            message: "Customer added successfully!",
            customerId: result.insertId
        });
    } catch (error) {
        console.error("Customer error:", error.message);

        res.status(500).json({
            success: false,
            message: "Could not add customer"
        });
    }
});

// ==================== GET CUSTOMERS ====================

app.get("/api/customers", async (req, res) => {
    try {
        const [customers] = await db.query(
            "SELECT id, name, phone, address FROM customers ORDER BY name"
        );

        res.json(customers);
    } catch (error) {
        console.error("Customers error:", error.message);

        res.status(500).json({
            success: false,
            message: "Failed to load customers"
        });
    }
});
/* ==================== DELETE CUSTOMER ==================== */

app.delete("/api/customers/:id", async (req, res) => {
    const connection = await db.getConnection();

    try {
        const customerId = Number(req.params.id);

        if (!Number.isInteger(customerId) || customerId < 1) {
            return res.status(400).json({
                success: false,
                message: "Invalid customer ID"
            });
        }

        await connection.beginTransaction();

        const [customers] = await connection.execute(
            "SELECT id FROM customers WHERE id = ? FOR UPDATE",
            [customerId]
        );

        if (customers.length === 0) {
            await connection.rollback();
            return res.status(404).json({
                success: false,
                message: "Customer not found"
            });
        }

        const [orders] = await connection.execute(
            `SELECT id, can_quantity, stock_managed, stock_deducted
             FROM orders
             WHERE customer_id = ?
             FOR UPDATE`,
            [customerId]
        );

        for (const order of orders) {
            if (order.stock_managed && order.stock_deducted) {
                await connection.execute(
                    `UPDATE can_stock
                     SET available_cans = LEAST(
                         total_cans,
                         available_cans + ?
                     )
                     WHERE id = 1`,
                    [order.can_quantity]
                );
            }
        }

        await connection.execute(
            "DELETE FROM orders WHERE customer_id = ?",
            [customerId]
        );

        await connection.execute(
            "DELETE FROM customers WHERE id = ?",
            [customerId]
        );

        await connection.commit();

        return res.json({
            success: true,
            message: "Customer and related orders deleted successfully"
        });

    } catch (error) {
        await connection.rollback();
        console.error("Delete customer error:", error);

        return res.status(500).json({
            success: false,
            message: "Could not delete customer and orders"
        });
    } finally {
        connection.release();
    }
});
// ==================== PLACE WATER CAN ORDER ====================

app.post("/api/orders", async (req, res) => {
    let connection;

    try {
        const { customerId, canQuantity } = req.body || {};
        const customer = Number(customerId);
        const quantity = Number(canQuantity);

        if (
            !Number.isInteger(customer) || customer < 1 ||
            !Number.isInteger(quantity) || quantity < 1 ||
            quantity > 10000
        ) {
            return res.status(400).json({
                success: false,
                message: "Enter a valid customer ID and can quantity"
            });
        }

        const price = quantity * 40;
        connection = await db.getConnection();

        await connection.beginTransaction();

        const [customers] = await connection.execute(
            "SELECT id FROM customers WHERE id = ?",
            [customer]
        );

        if (customers.length === 0) {
            await connection.rollback();
            return res.status(404).json({
                success: false,
                message: "Customer not found. Add customer first."
            });
        }

        const [stockRows] = await connection.execute(
            "SELECT available_cans FROM can_stock WHERE id = 1 FOR UPDATE"
        );

        if (stockRows.length === 0) {
            await connection.rollback();
            return res.status(500).json({
                success: false,
                message: "Stock record not found"
            });
        }

        const available = Number(stockRows[0].available_cans);

        if (quantity > available) {
            await connection.rollback();
            return res.status(400).json({
                success: false,
                message: `Insufficient stock. Only ${available} cans available.`
            });
        }

        await connection.execute(
            "UPDATE can_stock SET available_cans = available_cans - ? WHERE id = 1",
            [quantity]
        );

        const [result] = await connection.execute(
            `INSERT INTO orders
                (customer_id, can_quantity, price, stock_deducted, stock_managed)
             VALUES (?, ?, ?, 1, 1)`,
            [customer, quantity, price]
        );

        await connection.commit();

        res.status(201).json({
            success: true,
            message: "Order placed successfully!",
            orderId: result.insertId,
            totalPrice: price,
            remainingStock: available - quantity
        });
    } catch (error) {
        if (connection) {
            await connection.rollback().catch(() => {});
        }

        console.error("Order error:", error.message);

        res.status(500).json({
            success: false,
            message: "Could not place order"
        });
    } finally {
        if (connection) connection.release();
    }
});



// ==================== GET ORDER HISTORY ====================

app.get("/api/orders", async (req, res) => {
    try {
        const [orders] = await db.query(`
            SELECT
                orders.id,
                customers.name AS customer_name,
                customers.phone,
                orders.can_quantity,
                orders.price,
                orders.order_date,
                orders.status,
                orders.payment_status
            FROM orders
            JOIN customers ON orders.customer_id = customers.id
            ORDER BY orders.id DESC
        `);

        res.json(orders);
    } catch (error) {
        console.error("Order history error:", error.message);

        res.status(500).json({
            success: false,
            message: "Failed to fetch orders"
        });
    }
});

// ==================== UPDATE ORDER STATUS ====================
app.put("/api/orders/:id/status", async (req, res) => {
    let connection;

    try {
        const orderId = Number(req.params.id);
        const { status } = req.body || {};
        const allowedStatuses = ["Pending", "Delivered", "Cancelled"];

        if (!Number.isInteger(orderId) || orderId < 1) {
            return res.status(400).json({
                success: false,
                message: "Invalid order ID"
            });
        }

        if (!allowedStatuses.includes(status)) {
            return res.status(400).json({
                success: false,
                message: "Invalid order status"
            });
        }

        connection = await db.getConnection();
        await connection.beginTransaction();

        const [orders] = await connection.execute(
            `SELECT id, can_quantity, status, stock_managed, stock_deducted
             FROM orders WHERE id = ? FOR UPDATE`,
            [orderId]
        );

        if (orders.length === 0) {
            await connection.rollback();
            return res.status(404).json({
                success: false,
                message: "Order not found"
            });
        }

        const order = orders[0];
        const oldStatus = order.status;
        const managed = Number(order.stock_managed) === 1;
        const deducted = Number(order.stock_deducted) === 1;
        const quantity = Number(order.can_quantity);

        // Legacy orders are updated without changing stock.
        if (!managed) {
            await connection.execute(
                "UPDATE orders SET status = ? WHERE id = ?",
                [status, orderId]
            );

            await connection.commit();

            return res.json({
                success: true,
                message: "Order status updated. Stock unchanged for this older order."
            });
        }

        // No change in status: do not move stock again.
        if (oldStatus === status) {
            await connection.commit();

            return res.json({
                success: true,
                message: "Order status is already set."
            });
        }

        // Cancel an active order: return its cans exactly once.
        if (status === "Cancelled" && deducted) {
            await connection.execute(
                `UPDATE can_stock
                 SET available_cans = LEAST(total_cans, available_cans + ?)
                 WHERE id = 1`,
                [quantity]
            );

            await connection.execute(
                `UPDATE orders
                 SET status = ?, stock_deducted = 0
                 WHERE id = ?`,
                [status, orderId]
            );
        } else if (status !== "Cancelled" && !deducted) {
            // Reactivating a cancelled managed order requires stock.
            const [stockRows] = await connection.execute(
                "SELECT available_cans FROM can_stock WHERE id = 1 FOR UPDATE"
            );

            if (stockRows.length === 0) {
                await connection.rollback();
                return res.status(500).json({
                    success: false,
                    message: "Stock record not found"
                });
            }

            const available = Number(stockRows[0].available_cans);

            if (available < quantity) {
                await connection.rollback();
                return res.status(400).json({
                    success: false,
                    message: `Insufficient stock. Only ${available} cans available.`
                });
            }

            await connection.execute(
                "UPDATE can_stock SET available_cans = available_cans - ? WHERE id = 1",
                [quantity]
            );

            await connection.execute(
                `UPDATE orders
                 SET status = ?, stock_deducted = 1
                 WHERE id = ?`,
                [status, orderId]
            );
        } else {
            // Delivered <-> Pending does not change stock.
            await connection.execute(
                "UPDATE orders SET status = ? WHERE id = ?",
                [status, orderId]
            );
        }

        await connection.commit();

        res.json({
            success: true,
            message: "Order status and stock updated successfully."
        });
    } catch (error) {
        if (connection) {
            await connection.rollback().catch(() => {});
        }

        console.error("Status update error:", error.message);

        res.status(500).json({
            success: false,
            message: "Failed to update order status"
        });
    } finally {
        if (connection) connection.release();
    }
});
/* ==================== DELETE ORDER ==================== */

app.delete("/api/orders/:id", async (req, res) => {
    let connection;

    try {
        const orderId = Number(req.params.id);

        if (!Number.isInteger(orderId) || orderId < 1) {
            return res.status(400).json({
                success: false,
                message: "Invalid order ID"
            });
        }

        connection = await db.getConnection();
        await connection.beginTransaction();

        const [orders] = await connection.execute(
            `SELECT id, can_quantity, stock_managed, stock_deducted
             FROM orders
             WHERE id = ?
             FOR UPDATE`,
            [orderId]
        );

        if (orders.length === 0) {
            await connection.rollback();

            return res.status(404).json({
                success: false,
                message: "Order not found"
            });
        }

        const order = orders[0];
        const quantity = Number(order.can_quantity);
        const stockManaged = Number(order.stock_managed) === 1;
        const stockDeducted = Number(order.stock_deducted) === 1;

        // Return cans only if this order previously deducted stock.
        if (stockManaged && stockDeducted) {
            const [stockRows] = await connection.execute(
                "SELECT id FROM can_stock WHERE id = 1 FOR UPDATE"
            );

            if (stockRows.length === 0) {
                await connection.rollback();

                return res.status(500).json({
                    success: false,
                    message: "Stock record not found"
                });
            }

            await connection.execute(
                `UPDATE can_stock
                 SET available_cans =
                     LEAST(total_cans, available_cans + ?)
                 WHERE id = 1`,
                [quantity]
            );
        }

        await connection.execute(
            "DELETE FROM orders WHERE id = ?",
            [orderId]
        );

        await connection.commit();

        res.json({
            success: true,
            message: "Order deleted successfully"
        });
    } catch (error) {
        if (connection) {
            await connection.rollback().catch(() => {});
        }

        console.error("Delete order error:", error.message);

        res.status(500).json({
            success: false,
            message: "Could not delete order"
        });
    } finally {
        if (connection) {
            connection.release();
        }
    }
});
// ==================== UPDATE PAYMENT STATUS ====================

app.put("/api/orders/:id/payment", async (req, res) => {
    try {
        const orderId = Number(req.params.id);
        const { payment_status } = req.body || {};
        const allowedPayments = ["Paid", "Unpaid"];

        if (!Number.isInteger(orderId) || orderId < 1) {
            return res.status(400).json({
                success: false,
                message: "Invalid order ID"
            });
        }

        if (!allowedPayments.includes(payment_status)) {
            return res.status(400).json({
                success: false,
                message: "Invalid payment status"
            });
        }

        const [result] = await db.execute(
            "UPDATE orders SET payment_status = ? WHERE id = ?",
            [payment_status, orderId]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({
                success: false,
                message: "Order not found"
            });
        }

        res.json({
            success: true,
            message: "Payment status updated successfully"
        });
    } catch (error) {
        console.error("Payment status error:", error.message);

        res.status(500).json({
            success: false,
            message: "Failed to update payment status"
        });
    }
});

// ==================== DASHBOARD ====================

app.get("/api/dashboard", async (req, res) => {
    try {
        const [[customerResult]] = await db.query(
            "SELECT COUNT(*) AS totalCustomers FROM customers"
        );

        const [[orderResult]] = await db.query(
            "SELECT COUNT(*) AS totalOrders FROM orders"
        );

        const [[salesResult]] = await db.query(
            "SELECT COALESCE(SUM(price), 0) AS totalSales FROM orders WHERE status != 'Cancelled'"
        );

        res.json({
            totalCustomers: customerResult.totalCustomers,
            totalOrders: orderResult.totalOrders,
            totalSales: salesResult.totalSales
        });
    } catch (error) {
        console.error("Dashboard error:", error.message);

        res.status(500).json({
            success: false,
            message: "Dashboard data load failed"
        });
    }
});
app.get("/api/reports", async (req, res) => {
    try {
        const [[summary]] = await db.query(`
            SELECT
                (SELECT COUNT(*) FROM customers) AS totalCustomers,
                (SELECT COUNT(*) FROM orders) AS totalOrders,
                (SELECT COALESCE(SUM(price), 0)
                 FROM orders
                 WHERE status != 'Cancelled') AS totalSales,
                (SELECT COUNT(*) FROM orders
                 WHERE status = 'Delivered') AS deliveredOrders,
                (SELECT COUNT(*) FROM orders
                 WHERE status = 'Pending') AS pendingOrders,
                (SELECT COUNT(*) FROM orders
                 WHERE status = 'Cancelled') AS cancelledOrders
        `);

        const [orders] = await db.query(`
            SELECT
                orders.id,
                customers.name AS customer_name,
                orders.can_quantity,
                orders.price,
                orders.status,
                orders.payment_status,
                orders.order_date
            FROM orders
            JOIN customers ON customers.id = orders.customer_id
            ORDER BY orders.id DESC
        `);

        res.json({
            success: true,
            summary,
            orders
        });
    } catch (error) {
        console.error("Reports error:", error.message);
        res.status(500).json({
            success: false,
            message: "Failed to generate reports"
        });
    }
});

// Serve CSS, login.html and other public files.
// Keep this AFTER the protected home-page route.
app.get("/api/stock", async (req, res) => {
    try {
        const [rows] = await db.query(
            "SELECT * FROM can_stock WHERE id = 1"
        );

        if (rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: "Stock record not found"
            });
        }

        res.json({
            success: true,
            stock: rows[0]
        });
    } catch (error) {
        console.error("Get stock error:", error);
        res.status(500).json({
            success: false,
            message: "Failed to load stock"
        });
    }
});

app.put("/api/stock", async (req, res) => {
    try {
        const totalCans = Number(req.body.total_cans);
        const availableCans = Number(req.body.available_cans);

        if (
            !Number.isInteger(totalCans) ||
            !Number.isInteger(availableCans) ||
            totalCans < 0 ||
            availableCans < 0 ||
            availableCans > totalCans
        ) {
            return res.status(400).json({
                success: false,
                message: "Please enter valid stock quantities"
            });
        }

        const [result] = await db.query(
            `UPDATE can_stock
             SET total_cans = ?, available_cans = ?
             WHERE id = 1`,
            [totalCans, availableCans]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({
                success: false,
                message: "Stock record not found"
            });
        }

        res.json({
            success: true,
            message: "Stock updated successfully"
        });
    } catch (error) {
        console.error("Update stock error:", error);
        res.status(500).json({
            success: false,
            message: "Failed to update stock"
        });
    }
});

app.use(express.static(path.join(__dirname, "public")));

app.use((req, res) => {
    res.status(404).send("Page not found");
});

app.listen(PORT, () => {
    console.log(`AquaPure server running at http://localhost:${PORT}`);
});