package main

import (
	"github.com/gin-gonic/gin"
	"net/http"
)

type Order struct {
	ID     uint   `json:"id"`
	Item   string `json:"item"`
	Amount int    `json:"amount"`
}

// ListOrders returns all orders.
func listOrders(c *gin.Context) {
	c.JSON(http.StatusOK, []Order{})
}

// GetOrder returns a single order by ID.
func getOrder(c *gin.Context) {
	c.JSON(http.StatusOK, Order{ID: 1, Item: "Laptop", Amount: 1})
}

// CreateOrder creates a new order.
func createOrder(c *gin.Context) {
	var o Order
	c.ShouldBindJSON(&o)
	c.JSON(http.StatusCreated, o)
}

// UpdateOrder updates an existing order.
func updateOrder(c *gin.Context) {
	var o Order
	c.ShouldBindJSON(&o)
	c.JSON(http.StatusOK, o)
}

// DeleteOrder removes an order by ID.
func deleteOrder(c *gin.Context) {
	c.Status(http.StatusNoContent)
}

func main() {
	r := gin.Default()
	r.GET("/orders", listOrders)
	r.GET("/orders/:id", getOrder)
	r.POST("/orders", createOrder)
	r.PUT("/orders/:id", updateOrder)
	r.DELETE("/orders/:id", deleteOrder)
	r.Run(":8080")
}
