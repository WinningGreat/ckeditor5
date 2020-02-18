/**
 * @license Copyright (c) 2003-2020, CKSource - Frederico Knabben. All rights reserved.
 * For licensing, see LICENSE.md or https://ckeditor.com/legal/ckeditor-oss-license
 */

/**
 * @module table/tableselection
 */

import Plugin from '@ckeditor/ckeditor5-core/src/plugin';

import TableWalker from './tablewalker';
import TableUtils from './tableutils';
import { setupTableSelectionHighlighting } from './tableselection/converters';
import MouseSelectionHandler from './tableselection/mouseselectionhandler';

/**
 * The table selection plugin.
 *
 * It introduces the ability to select table cells. Table selection is described by two nodes: start and end.
 * Both are the oposite corners of an rectangle that spans over them.
 *
 * Consider a table:
 *
 *		    0   1   2   3
 *		  +---+---+---+---+
 *		0 | a | b | c | d |
 *		  +-------+   +---+
 *		1 | e | f |   | g |
 *		  +---+---+---+---+
 *		2 | h | i     | j |
 *		  +---+---+---+---+
 *
 * Setting table selection start as table cell "b" and end as table cell "g" will select table cells: "b", "c", "d", "f", and "g".
 * The cells that spans over multiple rows or columns can extend over the selection rectangle. For instance setting a selection from
 * table cell "a" to table cell "i" will create a selection in which table cell "i" will be extended over a rectangular of the selected
 * cell: "a", "b", "e", "f", "h", and "i".
 *
 * @extends module:core/plugin~Plugin
 */
export default class TableSelection extends Plugin {
	/**
	 * @inheritDoc
	 */
	static get pluginName() {
		return 'TableSelection';
	}

	/**
	 * @inheritDoc
	 */
	static get requires() {
		return [ TableUtils ];
	}

	/**
	 * @inheritDoc
	 */
	constructor( editor ) {
		super( editor );

		/**
		 * A mouse selection handler.
		 *
		 * @private
		 * @readonly
		 * @member {module:table/tableselection/mouseselectionhandler~MouseSelectionHandler}
		 */
		this._mouseHandler = new MouseSelectionHandler( this, this.editor.editing );

		/**
		 * A table utilities.
		 *
		 * @private
		 * @readonly
		 * @member {module:table/tableutils~TableUtils}
		 */
	}

	/**
	 * Flag indicating that there are selected table cells and the selection has more than one table cell.
	 *
	 * @type {Boolean}
	 */
	get hasMultiCellSelection() {
		return !!this._startElement && !!this._endElement && this._startElement !== this._endElement;
	}

	/**
	 * @inheritDoc
	 */
	init() {
		const editor = this.editor;
		const selection = editor.model.document.selection;

		this._tableUtils = editor.plugins.get( 'TableUtils' );

		setupTableSelectionHighlighting( editor, this );

		selection.on( 'change:range', () => this._clearSelectionOnExternalChange( selection ) );

		this.listenTo( editor.editing.view.document, 'copy', ( evt, data ) => {
			if ( !this.hasMultiCellSelection ) {
				return;
			}

			const dataTransfer = data.dataTransfer;

			data.preventDefault();
			evt.stop();

			const content = editor.data.toView( this.getSelectedTableAsFragment() );

			editor.editing.view.document.fire( 'clipboardOutput', { dataTransfer, content, method: evt.name } );
		}, { priority: 'normal' } );

		this.listenTo( editor.editing.view.document, 'cut', ( evt, data ) => {
			if ( this.hasMultiCellSelection ) {
				data.preventDefault();
				evt.stop();
			}
		}, { priority: 'high' } );
	}

	/**
	 * @inheritDoc
	 */
	destroy() {
		super.destroy();
		this._mouseHandler.stopListening();
	}

	/**
	 * Starts a selection process.
	 *
	 * This method enables the table selection process.
	 *
	 *		editor.plugins.get( 'TableSelection' ).startSelectingFrom( tableCell );
	 *
	 * @param {module:engine/model/element~Element} tableCell
	 */
	startSelectingFrom( tableCell ) {
		this.clearSelection();

		this._startElement = tableCell;
		this._endElement = tableCell;
	}

	/**
	 * Updates current table selection end element. Table selection is defined by #start and #end element.
	 * This method updates the #end element. Must be preceded by {@link #startSelectingFrom}.
	 *
	 *		editor.plugins.get( 'TableSelection' ).startSelectingFrom( startTableCell );
	 *
	 *		editor.plugins.get( 'TableSelection' ).setSelectingTo( endTableCell );
	 *
	 * @param {module:engine/model/element~Element} tableCell
	 */
	setSelectingTo( tableCell ) {
		if ( !this._startElement ) {
			this._startElement = tableCell;
		}

		const table = this._startElement.parent.parent;

		// Do not add tableCell to selection if it is from other table or is already set as end element.
		if ( table !== tableCell.parent.parent || this._endElement === tableCell ) {
			return;
		}

		this._endElement = tableCell;
		this._updateModelSelection();
	}

	/**
	 * Stops selection process (but do not clear the current selection). The selecting process is ended but the selection in model remains.
	 *
	 *		editor.plugins.get( 'TableSelection' ).startSelectingFrom( startTableCell );
	 *		editor.plugins.get( 'TableSelection' ).setSelectingTo( endTableCell );
	 *		editor.plugins.get( 'TableSelection' ).stopSelection();
	 *
	 * To clear selection use {@link #clearSelection}.
	 *
	 * @param {module:engine/model/element~Element} [tableCell]
	 */
	stopSelection( tableCell ) {
		if ( tableCell && tableCell.parent.parent === this._startElement.parent.parent ) {
			this._endElement = tableCell;
		}

		this._updateModelSelection();
	}

	/**
	 * Stops current selection process and clears table selection.
	 *
	 *		editor.plugins.get( 'TableSelection' ).startSelectingFrom( startTableCell );
	 *		editor.plugins.get( 'TableSelection' ).setSelectingTo( endTableCell );
	 *		editor.plugins.get( 'TableSelection' ).stopSelection();
	 *
	 *		editor.plugins.get( 'TableSelection' ).clearSelection();
	 */
	clearSelection() {
		this._startElement = undefined;
		this._endElement = undefined;
	}

	getSelectedTableAsFragment() {
		return this.editor.model.change( writer => {
			const fragment = writer.createDocumentFragment();

			const table = writer.createElement( 'table' );

			writer.insert( table, fragment, 0 );

			const rowsMap = new Map();
			const columnsIndexesMap = new Map();

			for ( const tableCell of this.getSelectedTableCells() ) {
				const row = tableCell.parent;

				if ( !rowsMap.has( row ) ) {
					const newRow = row._clone();
					writer.append( newRow, table );
					rowsMap.set( row, newRow );
				}

				const clonedCell = tableCell._clone( true );
				columnsIndexesMap.set( clonedCell, this._tableUtils.getCellLocation( tableCell ) );

				writer.append( clonedCell, rowsMap.get( row ) );
			}

			const { row: startRow, column: startColumn } = this._tableUtils.getCellLocation( this._startElement );
			const { row: endRow, column: endColumn } = this._tableUtils.getCellLocation( this._endElement );

			// Prepend cells.
			for ( const row of table.getChildren() ) {
				for ( const tableCell of Array.from( row.getChildren() ) ) {
					const { column } = this._tableUtils.getCellLocation( tableCell );
					const { column: originalColumn } = columnsIndexesMap.get( tableCell );

					const shiftedColumn = originalColumn - startColumn;

					if ( column !== shiftedColumn ) {
						for ( let i = 0; i < shiftedColumn - column; i++ ) {
							const prepCell = writer.createElement( 'tableCell' );
							writer.insert( prepCell, writer.createPositionBefore( tableCell ) );

							const paragraph = writer.createElement( 'paragraph' );

							writer.insert( paragraph, prepCell, 0 );
							writer.insertText( '', paragraph, 0 );
						}
					}
				}
			}

			// Trim table.
			const width = endColumn - startColumn + 1;
			const height = endRow - startRow + 1;

			for ( const row of table.getChildren() ) {
				for ( const tableCell of row.getChildren() ) {
					const colspan = parseInt( tableCell.getAttribute( 'colspan' ) || 1 );
					const rowspan = parseInt( tableCell.getAttribute( 'rowspan' ) || 1 );

					const { row, column } = this._tableUtils.getCellLocation( tableCell );

					if ( column + colspan > width ) {
						const newSpan = width - column;

						if ( newSpan > 1 ) {
							writer.setAttribute( 'colspan', newSpan, tableCell );
						} else {
							writer.removeAttribute( 'colspan', tableCell );
						}
					}

					if ( row + rowspan > height ) {
						const newSpan = height - row;

						if ( newSpan > 1 ) {
							writer.setAttribute( 'rowspan', newSpan, tableCell );
						} else {
							writer.removeAttribute( 'rowspan', tableCell );
						}
					}
				}
			}

			return fragment;
		} );
	}

	/**
	 * Returns iterator for selected table cells.
	 *
	 *		tableSelection.startSelectingFrom( startTableCell );
	 *		tableSelection.stopSelection( endTableCell );
	 *
	 *		const selectedTableCells = Array.from( tableSelection.getSelectedTableCells() );
	 *		// The above array will consist a rectangular table selection.
	 *
	 * @returns {Iterable.<module:engine/model/element~Element>}
	 */
	* getSelectedTableCells() {
		if ( !this.hasMultiCellSelection ) {
			return;
		}

		const startLocation = this._tableUtils.getCellLocation( this._startElement );
		const endLocation = this._tableUtils.getCellLocation( this._endElement );

		const startRow = startLocation.row > endLocation.row ? endLocation.row : startLocation.row;
		const endRow = startLocation.row > endLocation.row ? startLocation.row : endLocation.row;

		const startColumn = startLocation.column > endLocation.column ? endLocation.column : startLocation.column;
		const endColumn = startLocation.column > endLocation.column ? startLocation.column : endLocation.column;

		for ( const cellInfo of new TableWalker( this._startElement.parent.parent, { startRow, endRow } ) ) {
			if ( cellInfo.column >= startColumn && cellInfo.column <= endColumn ) {
				yield cellInfo.cell;
			}
		}
	}

	/**
	 * Set proper model selection for currently selected table cells.
	 *
	 * @private
	 */
	_updateModelSelection() {
		if ( !this.hasMultiCellSelection ) {
			return;
		}

		const editor = this.editor;
		const model = editor.model;

		const modelRanges = [];

		for ( const tableCell of this.getSelectedTableCells() ) {
			modelRanges.push( model.createRangeOn( tableCell ) );
		}

		// Update model's selection
		model.change( writer => {
			writer.setSelection( modelRanges );
		} );
	}

	/**
	 * Checks if selection has changed from an external source and it is required to clear internal state.
	 *
	 * @param {module:engine/model/documentselection~DocumentSelection} selection
	 * @private
	 */
	_clearSelectionOnExternalChange( selection ) {
		if ( selection.rangeCount <= 1 && this.hasMultiCellSelection ) {
			this.clearSelection();
		}
	}
}
