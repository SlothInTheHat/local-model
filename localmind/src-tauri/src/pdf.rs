//! PDF tools for the agent: merge and text extraction. Deliberately does NOT
//! include page-to-image rendering — that needs a real PDF renderer
//! (pdfium/poppler), which either means bundling a large native library or
//! depending on an external tool most Windows machines won't have installed.
//! Shipping a "sometimes works if you happen to have Poppler on PATH" tool
//! would be worse than not having one.

use std::collections::BTreeMap;
use std::path::PathBuf;

use lopdf::{Document, Object, ObjectId};

use crate::ensure_confined;

/// Merge multiple PDFs into one, in the given order. Standard lopdf recipe:
/// load each document, renumber its object ids past the previous document's
/// max (so ids never collide), then rebuild a single Pages tree pointing at
/// every page across all inputs.
#[tauri::command]
pub fn pdf_merge(paths: Vec<String>, dest_path: String) -> Result<(), String> {
    if paths.len() < 2 {
        return Err("pdf_merge: need at least 2 paths to merge".to_string());
    }
    let confined: Vec<PathBuf> = paths.iter().map(|p| ensure_confined(p)).collect::<Result<_, _>>()?;
    let dest = ensure_confined(&dest_path)?;
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    let mut max_id: u32 = 1;
    let mut documents_pages: BTreeMap<ObjectId, Object> = BTreeMap::new();
    let mut documents_objects: BTreeMap<ObjectId, Object> = BTreeMap::new();

    for path in &confined {
        let mut doc = Document::load(path).map_err(|e| format!("Cannot load {}: {e}", path.display()))?;
        doc.renumber_objects_with(max_id);
        max_id = doc.max_id + 1;

        documents_pages.extend(
            doc.get_pages()
                .into_values()
                .filter_map(|object_id| doc.get_object(object_id).ok().map(|obj| (object_id, obj.clone()))),
        );
        documents_objects.extend(doc.objects.clone());
    }

    let mut catalog_object: Option<(ObjectId, Object)> = None;
    let mut pages_object: Option<(ObjectId, Object)> = None;

    for (object_id, object) in documents_objects.iter() {
        match object.type_name().unwrap_or("") {
            "Catalog" => {
                catalog_object = Some((*object_id, object.clone()));
            }
            "Pages" => {
                let dict = object.as_dict().map_err(|e| e.to_string())?;
                let mut merged = dict.clone();
                if let Some((_, existing)) = &pages_object {
                    if let Ok(existing_dict) = existing.as_dict() {
                        merged.extend(existing_dict);
                    }
                }
                pages_object = Some((*object_id, Object::Dictionary(merged)));
            }
            _ => {}
        }
    }

    let (pages_id, pages_obj) = pages_object.ok_or_else(|| "pdf_merge: no Pages object found in inputs".to_string())?;
    let (catalog_id, catalog_obj) =
        catalog_object.ok_or_else(|| "pdf_merge: no Catalog object found in inputs".to_string())?;

    let mut document = Document::with_version("1.5");
    for (object_id, object) in documents_pages.iter() {
        document.objects.insert(*object_id, object.clone());
    }

    let mut pages_dict = pages_obj.as_dict().map_err(|e| e.to_string())?.clone();
    pages_dict.set(
        "Kids",
        Object::Array(documents_pages.keys().map(|id| Object::Reference(*id)).collect()),
    );
    pages_dict.set("Count", Object::Integer(documents_pages.len() as i64));
    document.objects.insert(pages_id, Object::Dictionary(pages_dict));

    let mut catalog_dict = catalog_obj.as_dict().map_err(|e| e.to_string())?.clone();
    catalog_dict.set("Pages", Object::Reference(pages_id));
    catalog_dict.remove(b"Outlines");
    document.objects.insert(catalog_id, Object::Dictionary(catalog_dict));

    document.trailer.set("Root", Object::Reference(catalog_id));
    document.max_id = document.objects.len() as u32;
    document.renumber_objects();

    document.save(&dest).map_err(|e| e.to_string())?;
    Ok(())
}

/// Extract plain text from a PDF. Works well for text-based PDFs; scanned/
/// image-only PDFs yield little or nothing since there's no OCR step here
/// (the app's existing screenshot OCR is a separate, Windows-only path not
/// wired to arbitrary files).
#[tauri::command]
pub fn pdf_to_text(path: String) -> Result<String, String> {
    let p = ensure_confined(&path)?;
    pdf_extract::extract_text(&p).map_err(|e| format!("pdf_to_text: {e}"))
}
