//! Computer-use via the Windows UI Automation accessibility tree — element-
//! targeted actions ("find the button named X, click it", "read the text in
//! field Y") rather than screenshot-plus-vision-model coordinate guessing.
//! This is deliberately narrower than raw mouse/keyboard injection: every
//! action here resolves a specific accessibility element by name first, and
//! only acts through an accessibility pattern (Invoke/Toggle/Select/Value) —
//! there is no coordinate-click fallback, so a stale/misidentified element
//! fails loudly instead of clicking whatever happens to be under a guessed
//! point on screen.
//!
//! Windows-only, following the same pattern as the rest of os_tools.rs
//! (window control, screenshot/OCR): other targets get a runtime
//! "unsupported" Err rather than failing to compile.

use serde::Serialize;

#[derive(Serialize, Clone)]
pub struct UiaElementInfo {
    pub name: String,
    pub control_type: String,
    pub automation_id: String,
    pub is_enabled: bool,
    pub supported_actions: Vec<String>,
    /// (x, y, width, height) in physical screen pixels — same coordinate
    /// space as monitor geometry and `capture_region` — or `None` when the
    /// element reports an empty/offscreen rect. `None` rather than zeros so
    /// callers can distinguish "no usable rect" from "rect at the origin".
    pub bounding_rect: Option<(f64, f64, f64, f64)>,
}

/// List elements in the given window's accessibility tree, optionally
/// filtered by control type (e.g. "button", "edit", "checkbox") — lets the
/// agent discover what's actually on screen before targeting one by name,
/// rather than guessing blind.
#[tauri::command]
pub fn uia_list_elements(
    window_id: String,
    control_type: Option<String>,
) -> Result<Vec<UiaElementInfo>, String> {
    #[cfg(target_os = "windows")]
    {
        windows_impl::list_elements(&window_id, control_type.as_deref())
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (window_id, control_type);
        Err("UI element inspection is only supported on Windows".to_string())
    }
}

/// Click an element found by (case-insensitive, substring-matched) name
/// inside the given window, via whichever accessibility pattern it actually
/// supports (Invoke, Toggle, SelectionItem, or legacy DoDefaultAction).
#[tauri::command]
pub fn uia_click_element(
    window_id: String,
    name: String,
    control_type: Option<String>,
) -> Result<String, String> {
    #[cfg(target_os = "windows")]
    {
        windows_impl::click_element(&window_id, &name, control_type.as_deref())
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (window_id, name, control_type);
        Err("UI element control is only supported on Windows".to_string())
    }
}

/// Read the text/value of an element found by name inside the given window
/// (edit fields, labels, static text, document content).
#[tauri::command]
pub fn uia_read_element_text(
    window_id: String,
    name: String,
    control_type: Option<String>,
) -> Result<String, String> {
    #[cfg(target_os = "windows")]
    {
        windows_impl::read_element_text(&window_id, &name, control_type.as_deref())
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (window_id, name, control_type);
        Err("UI element inspection is only supported on Windows".to_string())
    }
}

/// Set the text/value of an editable element found by name inside the given
/// window (text boxes, combo box edit areas) — requires the element to
/// support ValuePattern or the legacy accessible Value action.
#[tauri::command]
pub fn uia_set_element_text(
    window_id: String,
    name: String,
    value: String,
    control_type: Option<String>,
) -> Result<String, String> {
    #[cfg(target_os = "windows")]
    {
        windows_impl::set_element_text(&window_id, &name, &value, control_type.as_deref())
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (window_id, name, value, control_type);
        Err("UI element control is only supported on Windows".to_string())
    }
}

#[cfg(target_os = "windows")]
mod windows_impl {
    use super::UiaElementInfo;
    use windows::core::BSTR;
    use windows::Win32::Foundation::{HWND, RECT};
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER,
        COINIT_APARTMENTTHREADED,
    };
    use windows::Win32::System::Variant::{VARIANT, VT_I4};
    use windows::Win32::UI::Accessibility::{
        CUIAutomation, IUIAutomation, IUIAutomationCondition, IUIAutomationElement,
        IUIAutomationInvokePattern, IUIAutomationLegacyIAccessiblePattern,
        IUIAutomationSelectionItemPattern, IUIAutomationTextPattern, IUIAutomationTogglePattern,
        IUIAutomationValuePattern, TreeScope_Descendants, UIA_ControlTypePropertyId,
        UIA_InvokePatternId, UIA_LegacyIAccessiblePatternId, UIA_SelectionItemPatternId,
        UIA_TextPatternId, UIA_TogglePatternId, UIA_ValuePatternId,
    };

    /// The 39 well-known Win32 UI Automation control type IDs (documented,
    /// stable constants 50000-50038) mapped to their lowercase friendly
    /// names — hardcoded rather than pulled from windows-rs symbol names so
    /// the mapping doesn't depend on exact constant spelling in this crate
    /// version; the numeric IDs themselves are a fixed part of the Win32 ABI.
    const CONTROL_TYPES: &[(i32, &str)] = &[
        (50000, "button"),
        (50001, "calendar"),
        (50002, "checkbox"),
        (50003, "combobox"),
        (50004, "edit"),
        (50005, "hyperlink"),
        (50006, "image"),
        (50007, "listitem"),
        (50008, "list"),
        (50009, "menu"),
        (50010, "menubar"),
        (50011, "menuitem"),
        (50012, "progressbar"),
        (50013, "radiobutton"),
        (50014, "scrollbar"),
        (50015, "slider"),
        (50016, "spinner"),
        (50017, "statusbar"),
        (50018, "tab"),
        (50019, "tabitem"),
        (50020, "text"),
        (50021, "toolbar"),
        (50022, "tooltip"),
        (50023, "tree"),
        (50024, "treeitem"),
        (50025, "custom"),
        (50026, "group"),
        (50027, "thumb"),
        (50028, "datagrid"),
        (50029, "dataitem"),
        (50030, "document"),
        (50031, "splitbutton"),
        (50032, "window"),
        (50033, "pane"),
        (50034, "header"),
        (50035, "headeritem"),
        (50036, "table"),
        (50037, "titlebar"),
        (50038, "separator"),
    ];

    fn control_type_name(id: i32) -> String {
        CONTROL_TYPES
            .iter()
            .find(|(cid, _)| *cid == id)
            .map(|(_, name)| name.to_string())
            .unwrap_or_else(|| format!("unknown({id})"))
    }

    fn control_type_id(name: &str) -> Option<i32> {
        let lower = name.trim().to_lowercase();
        CONTROL_TYPES
            .iter()
            .find(|(_, n)| *n == lower)
            .map(|(id, _)| *id)
    }

    fn parse_hwnd(id: &str) -> Result<HWND, String> {
        let raw: isize = id.trim().parse().map_err(|_| format!("Invalid window id '{id}'"))?;
        Ok(HWND(raw as *mut core::ffi::c_void))
    }

    /// RAII-ish guard: initializes a COM apartment for the calling thread if
    /// one isn't already active, and only uninitializes on drop if this call
    /// is what owns it — mirrors the same care os_tools.rs's OCR path takes
    /// (RPC_E_CHANGED_MODE means someone else already set a different mode;
    /// tearing that down out from under them would be wrong).
    struct ComGuard {
        owned: bool,
    }
    impl ComGuard {
        fn new() -> Self {
            let hr = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };
            Self { owned: hr.is_ok() }
        }
    }
    impl Drop for ComGuard {
        fn drop(&mut self) {
            if self.owned {
                unsafe { CoUninitialize() };
            }
        }
    }

    fn create_automation() -> Result<IUIAutomation, String> {
        unsafe { CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER) }
            .map_err(|e| format!("Failed to create UI Automation instance: {e}"))
    }

    fn root_element(automation: &IUIAutomation, window_id: &str) -> Result<IUIAutomationElement, String> {
        let hwnd = parse_hwnd(window_id)?;
        unsafe { automation.ElementFromHandle(hwnd) }
            .map_err(|e| format!("Window '{window_id}' not found or has no accessibility tree: {e}"))
    }

    fn element_name(el: &IUIAutomationElement) -> String {
        unsafe { el.CurrentName() }
            .map(|b| b.to_string())
            .unwrap_or_default()
    }

    fn element_automation_id(el: &IUIAutomationElement) -> String {
        unsafe { el.CurrentAutomationId() }
            .map(|b| b.to_string())
            .unwrap_or_default()
    }

    fn element_control_type(el: &IUIAutomationElement) -> i32 {
        unsafe { el.CurrentControlType() }.map(|id| id.0).unwrap_or(0)
    }

    fn element_enabled(el: &IUIAutomationElement) -> bool {
        unsafe { el.CurrentIsEnabled() }.map(|b| b.as_bool()).unwrap_or(false)
    }

    /// Physical-pixel bounding rect, or `None` for an offscreen/collapsed
    /// element (zero or negative width/height) — those aren't useful
    /// highlight targets and would otherwise draw a degenerate ring at the
    /// origin.
    fn element_bounding_rect(el: &IUIAutomationElement) -> Option<(f64, f64, f64, f64)> {
        let rect: RECT = unsafe { el.CurrentBoundingRectangle() }.ok()?;
        let width = (rect.right - rect.left) as f64;
        let height = (rect.bottom - rect.top) as f64;
        if width <= 0.0 || height <= 0.0 {
            return None;
        }
        Some((rect.left as f64, rect.top as f64, width, height))
    }

    fn has_pattern<T: windows::core::Interface>(el: &IUIAutomationElement, pattern_id: windows::Win32::UI::Accessibility::UIA_PATTERN_ID) -> bool {
        unsafe { el.GetCurrentPatternAs::<T>(pattern_id) }.is_ok()
    }

    fn get_pattern<T: windows::core::Interface>(el: &IUIAutomationElement, pattern_id: windows::Win32::UI::Accessibility::UIA_PATTERN_ID) -> Option<T> {
        unsafe { el.GetCurrentPatternAs::<T>(pattern_id) }.ok()
    }

    fn supported_actions(el: &IUIAutomationElement) -> Vec<String> {
        let mut actions = Vec::new();
        if has_pattern::<IUIAutomationInvokePattern>(el, UIA_InvokePatternId) {
            actions.push("click".to_string());
        }
        if has_pattern::<IUIAutomationTogglePattern>(el, UIA_TogglePatternId) {
            actions.push("toggle".to_string());
        }
        if has_pattern::<IUIAutomationSelectionItemPattern>(el, UIA_SelectionItemPatternId) {
            actions.push("select".to_string());
        }
        if has_pattern::<IUIAutomationValuePattern>(el, UIA_ValuePatternId) {
            actions.push("read/write text".to_string());
        }
        if has_pattern::<IUIAutomationTextPattern>(el, UIA_TextPatternId) {
            actions.push("read text".to_string());
        }
        actions
    }

    /// Enumerates matching descendants of `root` into a flat list, capped
    /// well below anything that would make a single response unwieldy —
    /// dense apps (browsers, IDEs) can have thousands of accessibility
    /// nodes. When `control_type_id` is given, the filter is pushed down
    /// into the COM call itself via a PropertyCondition rather than
    /// fetched-then-discarded client-side: a `TrueCondition` FindAll on a
    /// dense tree can burn the entire MAX_ELEMENTS cap on irrelevant nodes
    /// before ever reaching a matching one buried deeper in traversal
    /// order, silently making a real target undiscoverable. Filtering at
    /// the COM level means the cap applies to the FILTERED set, not the
    /// raw one.
    const MAX_ELEMENTS: usize = 400;

    /// Builds a VARIANT wrapping a single i32 (VT_I4) — the shape
    /// CreatePropertyCondition expects for UIA_ControlTypePropertyId's
    /// value. windows-rs has no convenience constructor for this raw COM
    /// union; this is the standard, if verbose, way to populate one.
    fn i32_variant(value: i32) -> VARIANT {
        let mut variant = VARIANT::default();
        unsafe {
            (*variant.Anonymous.Anonymous).vt = VT_I4;
            (*variant.Anonymous.Anonymous).Anonymous.lVal = value;
        }
        variant
    }

    fn find_all_descendants(
        automation: &IUIAutomation,
        root: &IUIAutomationElement,
        control_type_id: Option<i32>,
    ) -> Result<Vec<IUIAutomationElement>, String> {
        let condition: IUIAutomationCondition = match control_type_id {
            Some(id) => unsafe {
                automation
                    .CreatePropertyCondition(UIA_ControlTypePropertyId, &i32_variant(id))
                    .map_err(|e| format!("CreatePropertyCondition failed: {e}"))?
            },
            None => unsafe {
                automation.CreateTrueCondition().map_err(|e| format!("CreateTrueCondition failed: {e}"))?
            },
        };
        let array = unsafe { root.FindAll(TreeScope_Descendants, &condition) }
            .map_err(|e| format!("FindAll failed: {e}"))?;
        let count = unsafe { array.Length() }.map_err(|e| format!("{e}"))?;
        let mut out = Vec::new();
        for i in 0..count.min(MAX_ELEMENTS as i32) {
            if let Ok(el) = unsafe { array.GetElement(i) } {
                out.push(el);
            }
        }
        Ok(out)
    }

    pub fn list_elements(window_id: &str, control_type: Option<&str>) -> Result<Vec<UiaElementInfo>, String> {
        let _com = ComGuard::new();
        let automation = create_automation()?;
        let root = root_element(&automation, window_id)?;
        let filter_id = control_type.and_then(control_type_id);
        if control_type.is_some() && filter_id.is_none() {
            return Err(format!(
                "Unknown control_type '{}' — expected one of: {}",
                control_type.unwrap(),
                CONTROL_TYPES.iter().map(|(_, n)| *n).collect::<Vec<_>>().join(", ")
            ));
        }

        let elements = find_all_descendants(&automation, &root, filter_id)?;
        let infos = elements
            .iter()
            .filter_map(|el| {
                let ct = element_control_type(el);
                let name = element_name(el);
                let automation_id = element_automation_id(el);
                // Skip anonymous, non-actionable nodes (typically decorative
                // containers) — they only add noise for an agent trying to
                // find something to name and act on.
                if name.trim().is_empty() && automation_id.trim().is_empty() {
                    return None;
                }
                Some(UiaElementInfo {
                    name,
                    control_type: control_type_name(ct),
                    automation_id,
                    is_enabled: element_enabled(el),
                    supported_actions: supported_actions(el),
                    bounding_rect: element_bounding_rect(el),
                })
            })
            .collect();
        Ok(infos)
    }

    /// Finds the best-matching descendant by case-insensitive name match
    /// (exact match preferred over substring) and optional control-type
    /// filter. Mirrors the matching approach `resolve_start_app` already
    /// uses elsewhere in this file for the same reason: a loose fuzzy match
    /// risks acting on the wrong element, so this requires at least a
    /// substring match rather than any kind of edit-distance scoring.
    fn find_best_match(
        automation: &IUIAutomation,
        root: &IUIAutomationElement,
        name: &str,
        control_type: Option<&str>,
    ) -> Result<IUIAutomationElement, String> {
        let filter_id = match control_type {
            Some(ct) => Some(control_type_id(ct).ok_or_else(|| {
                format!(
                    "Unknown control_type '{ct}' — expected one of: {}",
                    CONTROL_TYPES.iter().map(|(_, n)| *n).collect::<Vec<_>>().join(", ")
                )
            })?),
            None => None,
        };

        let elements = find_all_descendants(automation, root, filter_id)?;
        let query = name.trim().to_lowercase();
        if query.is_empty() {
            return Err("Element name must not be empty".to_string());
        }

        let mut exact: Option<IUIAutomationElement> = None;
        let mut partial: Option<IUIAutomationElement> = None;
        for el in elements {
            let el_name = element_name(&el).to_lowercase();
            if el_name.is_empty() {
                continue;
            }
            if el_name == query {
                exact = Some(el);
                break;
            }
            if partial.is_none() && (el_name.contains(&query) || query.contains(&el_name)) {
                partial = Some(el);
            }
        }

        exact.or(partial).ok_or_else(|| {
            format!(
                "No element named like '{name}'{} found in that window — call uia_list_elements first to see what's actually there.",
                control_type.map(|ct| format!(" (control_type: {ct})")).unwrap_or_default()
            )
        })
    }

    pub fn click_element(window_id: &str, name: &str, control_type: Option<&str>) -> Result<String, String> {
        let _com = ComGuard::new();
        let automation = create_automation()?;
        let root = root_element(&automation, window_id)?;
        let el = find_best_match(&automation, &root, name, control_type)?;
        let found_name = element_name(&el);
        let _ = unsafe { el.SetFocus() };

        if let Some(pattern) = get_pattern::<IUIAutomationInvokePattern>(&el, UIA_InvokePatternId) {
            unsafe { pattern.Invoke() }.map_err(|e| format!("Invoke failed on '{found_name}': {e}"))?;
            return Ok(format!("Clicked '{found_name}'"));
        }
        if let Some(pattern) = get_pattern::<IUIAutomationTogglePattern>(&el, UIA_TogglePatternId) {
            unsafe { pattern.Toggle() }.map_err(|e| format!("Toggle failed on '{found_name}': {e}"))?;
            return Ok(format!("Toggled '{found_name}'"));
        }
        if let Some(pattern) = get_pattern::<IUIAutomationSelectionItemPattern>(&el, UIA_SelectionItemPatternId) {
            unsafe { pattern.Select() }.map_err(|e| format!("Select failed on '{found_name}': {e}"))?;
            return Ok(format!("Selected '{found_name}'"));
        }
        if let Some(pattern) = get_pattern::<IUIAutomationLegacyIAccessiblePattern>(&el, UIA_LegacyIAccessiblePatternId) {
            unsafe { pattern.DoDefaultAction() }.map_err(|e| format!("DoDefaultAction failed on '{found_name}': {e}"))?;
            return Ok(format!("Activated '{found_name}'"));
        }

        Err(format!(
            "'{found_name}' doesn't support any known click/activate pattern (invoke/toggle/select/legacy) — it may not be an actionable control."
        ))
    }

    pub fn read_element_text(window_id: &str, name: &str, control_type: Option<&str>) -> Result<String, String> {
        let _com = ComGuard::new();
        let automation = create_automation()?;
        let root = root_element(&automation, window_id)?;
        let el = find_best_match(&automation, &root, name, control_type)?;
        let found_name = element_name(&el);

        if let Some(pattern) = get_pattern::<IUIAutomationValuePattern>(&el, UIA_ValuePatternId) {
            if let Ok(value) = unsafe { pattern.CurrentValue() } {
                return Ok(value.to_string());
            }
        }
        if let Some(pattern) = get_pattern::<IUIAutomationTextPattern>(&el, UIA_TextPatternId) {
            if let Ok(range) = unsafe { pattern.DocumentRange() } {
                if let Ok(text) = unsafe { range.GetText(-1) } {
                    return Ok(text.to_string());
                }
            }
        }
        if let Some(pattern) = get_pattern::<IUIAutomationLegacyIAccessiblePattern>(&el, UIA_LegacyIAccessiblePatternId) {
            if let Ok(value) = unsafe { pattern.CurrentValue() } {
                return Ok(value.to_string());
            }
        }

        // Nothing text-bearing supported — fall back to the element's own
        // name rather than erroring, since that's still meaningful for
        // labels/static text/buttons the caller may be probing generically.
        Ok(found_name)
    }

    pub fn set_element_text(window_id: &str, name: &str, value: &str, control_type: Option<&str>) -> Result<String, String> {
        let _com = ComGuard::new();
        let automation = create_automation()?;
        let root = root_element(&automation, window_id)?;
        let el = find_best_match(&automation, &root, name, control_type)?;
        let found_name = element_name(&el);
        let bstr_value = BSTR::from(value);

        let _ = unsafe { el.SetFocus() };

        if let Some(pattern) = get_pattern::<IUIAutomationValuePattern>(&el, UIA_ValuePatternId) {
            unsafe { pattern.SetValue(&bstr_value) }.map_err(|e| format!("SetValue failed on '{found_name}': {e}"))?;
            return Ok(format!("Set text of '{found_name}'"));
        }
        if let Some(pattern) = get_pattern::<IUIAutomationLegacyIAccessiblePattern>(&el, UIA_LegacyIAccessiblePatternId) {
            unsafe { pattern.SetValue(&bstr_value) }.map_err(|e| format!("SetValue failed on '{found_name}': {e}"))?;
            return Ok(format!("Set text of '{found_name}'"));
        }

        Err(format!(
            "'{found_name}' doesn't support setting text (no ValuePattern/legacy Value action) — it may not be an editable field."
        ))
    }
}
