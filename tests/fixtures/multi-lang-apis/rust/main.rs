use actix_web::{get, post, put, patch, delete, web, App, HttpServer, HttpResponse, Responder};
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize)]
struct Product {
    id: u32,
    name: String,
    price: f64,
}

/// List all products in the catalog.
#[get("/products")]
async fn list_products() -> impl Responder {
    HttpResponse::Ok().json(Vec::<Product>::new())
}

/// Get a single product by its ID.
#[get("/products/{id}")]
async fn get_product(path: web::Path<u32>) -> impl Responder {
    let id = path.into_inner();
    HttpResponse::Ok().json(Product { id, name: "Widget".into(), price: 9.99 })
}

/// Create a new product.
#[post("/products")]
async fn create_product(body: web::Json<Product>) -> impl Responder {
    HttpResponse::Created().json(body.into_inner())
}

/// Partially update a product.
#[patch("/products/{id}")]
async fn update_product(path: web::Path<u32>, body: web::Json<Product>) -> impl Responder {
    HttpResponse::Ok().json(body.into_inner())
}

/// Delete a product by ID.
#[delete("/products/{id}")]
async fn delete_product(path: web::Path<u32>) -> impl Responder {
    HttpResponse::NoContent().finish()
}

#[actix_web::main]
async fn main() -> std::io::Result<()> {
    HttpServer::new(|| {
        App::new()
            .service(list_products)
            .service(get_product)
            .service(create_product)
            .service(update_product)
            .service(delete_product)
    })
    .bind("127.0.0.1:8080")?
    .run()
    .await
}
