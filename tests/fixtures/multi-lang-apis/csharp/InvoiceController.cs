using Microsoft.AspNetCore.Mvc;

namespace InvoiceApi.Controllers;

[ApiController]
[Route("api/[controller]")]
public class InvoiceController : ControllerBase
{
    /// <summary>List all invoices.</summary>
    [HttpGet]
    public IActionResult GetAllInvoices() => Ok(Array.Empty<Invoice>());

    /// <summary>Get invoice by ID.</summary>
    [HttpGet("{id}")]
    public IActionResult GetInvoice(int id) => Ok(new Invoice(id, "INV-001", 500.00m));

    /// <summary>Create a new invoice.</summary>
    [HttpPost]
    public IActionResult CreateInvoice([FromBody] Invoice invoice) => Created($"/api/invoice/{invoice.Id}", invoice);

    /// <summary>Update an existing invoice.</summary>
    [HttpPut("{id}")]
    public IActionResult UpdateInvoice(int id, [FromBody] Invoice invoice) => Ok(invoice);

    /// <summary>Delete an invoice.</summary>
    [HttpDelete("{id}")]
    public IActionResult DeleteInvoice(int id) => NoContent();
}

public record Invoice(int Id, string Number, decimal Amount);
