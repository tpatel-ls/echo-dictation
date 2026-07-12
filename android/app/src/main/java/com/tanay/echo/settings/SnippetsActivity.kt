package com.tanay.echo.settings

import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.widget.ImageButton
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import android.text.Editable
import android.text.TextWatcher
import androidx.appcompat.app.AppCompatActivity
import com.google.android.material.button.MaterialButton
import com.google.android.material.textfield.TextInputEditText
import com.tanay.echo.R
import com.tanay.echo.data.SnippetDatabase
import com.tanay.echo.data.SnippetEntity
import com.tanay.echo.data.SnippetStore
import com.tanay.echo.snippet.filterSnippetItems

/**
 * Manage voice snippets (cue → expansion); speaking a cue during dictation pastes its expansion.
 * The list is a simple inflated LinearLayout — snippet counts are small, so no RecyclerView is
 * warranted. DB calls block, so they run on a background thread with results posted to the UI.
 */
class SnippetsActivity : AppCompatActivity() {
    private val store by lazy { SnippetStore(SnippetDatabase.get(this)) }
    private lateinit var cue: TextInputEditText
    private lateinit var expansion: TextInputEditText
    private lateinit var saveButton: MaterialButton
    private lateinit var list: LinearLayout
    private lateinit var empty: TextView
    private lateinit var search: TextInputEditText
    private var rows: List<SnippetEntity> = emptyList()
    private var editingId: Long? = null // null = adding new; set = editing that row

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_snippets)
        cue = findViewById(R.id.snippet_cue)
        expansion = findViewById(R.id.snippet_expansion)
        saveButton = findViewById(R.id.snippet_save)
        list = findViewById(R.id.snippet_list)
        empty = findViewById(R.id.snippet_empty)
        search = findViewById(R.id.snippet_search)
        search.addTextChangedListener(object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) = Unit
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) = bindFiltered()
            override fun afterTextChanged(s: Editable?) = Unit
        })
        saveButton.setOnClickListener { save() }
        reload()
    }

    private fun save() {
        val c = cue.text?.toString()?.trim().orEmpty()
        val e = expansion.text?.toString().orEmpty()
        if (c.isEmpty()) {
            Toast.makeText(this, R.string.snippet_cue_required, Toast.LENGTH_SHORT).show()
            return
        }
        val id = editingId
        Thread {
            if (id == null) store.add(c, e) else store.update(id, c, e)
            runOnUiThread {
                resetForm()
                reload()
            }
        }.start()
    }

    private fun reload() = Thread {
        val loaded = store.rows()
        runOnUiThread {
            rows = loaded
            bindFiltered()
        }
    }.start()

    private fun bindFiltered() {
        val filtered = filterSnippetItems(rows, search.text?.toString().orEmpty(), { it.cue }, { it.expansion })
        bind(filtered)
    }

    private fun bind(rows: List<SnippetEntity>) {
        list.removeAllViews()
        empty.visibility = if (rows.isEmpty()) View.VISIBLE else View.GONE
        val inflater = LayoutInflater.from(this)
        for (row in rows) {
            val v = inflater.inflate(R.layout.snippet_row, list, false)
            v.findViewById<TextView>(R.id.row_cue).text = row.cue
            v.findViewById<TextView>(R.id.row_expansion).text = row.expansion
            v.setOnClickListener { startEditing(row) }
            v.findViewById<ImageButton>(R.id.row_delete).setOnClickListener { delete(row.id) }
            list.addView(v)
        }
    }

    private fun startEditing(row: SnippetEntity) {
        editingId = row.id
        cue.setText(row.cue)
        expansion.setText(row.expansion)
        saveButton.setText(R.string.snippet_save)
        cue.requestFocus()
    }

    private fun delete(id: Long) = Thread {
        store.delete(id)
        runOnUiThread {
            if (editingId == id) resetForm() // was editing the row we just deleted
            reload()
        }
    }.start()

    private fun resetForm() {
        editingId = null
        cue.setText("")
        expansion.setText("")
        saveButton.setText(R.string.snippet_add)
    }
}
