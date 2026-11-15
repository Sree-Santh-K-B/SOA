<?php
/**
 * Plugin Name: Billing API Invoices for WooCommerce
 * Description: Sends WooCommerce orders and refunds to the Billing API and attaches the PDF invoice to customer order emails.
 * Version: 0.1.0
 * Requires at least: 6.0
 * Requires PHP: 7.4
 * Requires Plugins: woocommerce
 * WC requires at least: 7.0
 * License: GPL-2.0-or-later
 * Text Domain: billing-api-invoices
 */

defined( 'ABSPATH' ) || exit;

final class Billing_API_Invoices {

	const META_INVOICE_ID     = '_billing_api_invoice_id';
	const META_INVOICE_NUMBER = '_billing_api_invoice_number';
	const META_HSN            = '_hsn_code';
	const CRON_HOOK           = 'billing_api_invoices_cleanup';

	/** @var array<int,string> PDF paths downloaded during this request, by order id. */
	private static $pdf_cache = array();

	public static function init() {
		// Settings: WooCommerce > Settings > Advanced > Billing API.
		add_filter( 'woocommerce_get_sections_advanced', array( __CLASS__, 'add_settings_section' ) );
		add_filter( 'woocommerce_get_settings_advanced', array( __CLASS__, 'add_settings' ), 10, 2 );

		// Create the invoice once the order is paid / being fulfilled.
		add_action( 'woocommerce_order_status_processing', array( __CLASS__, 'on_order_ready' ), 5 );
		add_action( 'woocommerce_order_status_completed', array( __CLASS__, 'on_order_ready' ), 5 );

		// Attach the PDF to customer emails.
		add_filter( 'woocommerce_email_attachments', array( __CLASS__, 'attach_invoice' ), 10, 3 );

		// Mirror refunds.
		add_action( 'woocommerce_order_refunded', array( __CLASS__, 'on_order_refunded' ), 10, 2 );

		// HSN/SAC code on products.
		add_action( 'woocommerce_product_options_general_product_data', array( __CLASS__, 'render_hsn_field' ) );
		add_action( 'woocommerce_process_product_meta', array( __CLASS__, 'save_hsn_field' ) );

		// Manual "create invoice" action on the order screen.
		add_filter( 'woocommerce_order_actions', array( __CLASS__, 'add_order_action' ) );
		add_action( 'woocommerce_order_action_billing_api_create_invoice', array( __CLASS__, 'run_order_action' ) );

		add_action( self::CRON_HOOK, array( __CLASS__, 'cleanup_temp_files' ) );
	}

	/* ---------------------------------------------------------------------
	 * Settings
	 * ------------------------------------------------------------------- */

	public static function add_settings_section( $sections ) {
		$sections['billing_api'] = __( 'Billing API', 'billing-api-invoices' );
		return $sections;
	}

	public static function add_settings( $settings, $current_section ) {
		if ( 'billing_api' !== $current_section ) {
			return $settings;
		}
		return array(
			array(
				'title' => __( 'Billing API', 'billing-api-invoices' ),
				'type'  => 'title',
				'desc'  => __( 'Orders are sent to the Billing API when they reach Processing or Completed. The PDF invoice is attached to the selected customer emails.', 'billing-api-invoices' ),
				'id'    => 'billing_api_options',
			),
			array(
				'title'       => __( 'API URL', 'billing-api-invoices' ),
				'id'          => 'billing_api_url',
				'type'        => 'text',
				'placeholder' => 'https://billing.example.com',
				'desc'        => __( 'Base URL, without /v1.', 'billing-api-invoices' ),
			),
			array(
				'title' => __( 'API key', 'billing-api-invoices' ),
				'id'    => 'billing_api_key',
				'type'  => 'password',
			),
			array(
				'title'   => __( 'Attach invoice to', 'billing-api-invoices' ),
				'id'      => 'billing_api_emails',
				'type'    => 'multiselect',
				'class'   => 'wc-enhanced-select',
				'default' => array( 'customer_processing_order', 'customer_completed_order', 'customer_invoice' ),
				'options' => array(
					'customer_processing_order' => __( 'Processing order', 'billing-api-invoices' ),
					'customer_completed_order'  => __( 'Completed order', 'billing-api-invoices' ),
					'customer_invoice'          => __( 'Customer invoice / order details', 'billing-api-invoices' ),
					'customer_refunded_order'   => __( 'Refunded order', 'billing-api-invoices' ),
				),
			),
			array(
				'title' => __( 'Shipping HSN/SAC code', 'billing-api-invoices' ),
				'id'    => 'billing_api_shipping_hsn',
				'type'  => 'text',
				'desc'  => __( 'Optional. Used for the shipping line on GST invoices.', 'billing-api-invoices' ),
			),
			array(
				'type' => 'sectionend',
				'id'   => 'billing_api_options',
			),
		);
	}

	private static function is_configured() {
		return get_option( 'billing_api_url' ) && get_option( 'billing_api_key' );
	}

	/* ---------------------------------------------------------------------
	 * API client
	 * ------------------------------------------------------------------- */

	/**
	 * @return array|WP_Error Decoded JSON body, or the raw response array when $raw is true.
	 */
	private static function request( $method, $path, $body = null, $raw = false ) {
		$args = array(
			'method'  => $method,
			'timeout' => 20,
			'headers' => array(
				'Authorization' => 'Bearer ' . get_option( 'billing_api_key' ),
				'Accept'        => $raw ? 'application/pdf' : 'application/json',
			),
		);
		if ( null !== $body ) {
			$args['headers']['Content-Type'] = 'application/json';
			$args['body']                    = wp_json_encode( $body );
		}

		$response = wp_remote_request( untrailingslashit( get_option( 'billing_api_url' ) ) . $path, $args );
		if ( is_wp_error( $response ) ) {
			return $response;
		}

		$code = wp_remote_retrieve_response_code( $response );
		if ( $code < 200 || $code >= 300 ) {
			$data    = json_decode( wp_remote_retrieve_body( $response ), true );
			$message = isset( $data['error']['message'] ) ? $data['error']['message'] : 'HTTP ' . $code;
			if ( ! empty( $data['error']['details'] ) ) {
				$message .= ' ' . wp_json_encode( $data['error']['details'] );
			}
			return new WP_Error( 'billing_api_error', $message );
		}
		return $raw ? $response : json_decode( wp_remote_retrieve_body( $response ), true );
	}

	/* ---------------------------------------------------------------------
	 * Order -> invoice
	 * ------------------------------------------------------------------- */

	/** Amount in the currency's minor unit (paise, cents, yen). */
	private static function to_minor( $amount, $currency ) {
		$zero  = array( 'BIF', 'CLP', 'DJF', 'GNF', 'JPY', 'KMF', 'KRW', 'MGA', 'PYG', 'RWF', 'UGX', 'VND', 'VUV', 'XAF', 'XOF', 'XPF' );
		$three = array( 'BHD', 'IQD', 'JOD', 'KWD', 'LYD', 'OMR', 'TND' );
		$exp   = in_array( $currency, $zero, true ) ? 0 : ( in_array( $currency, $three, true ) ? 3 : 2 );
		return (int) round( (float) $amount * pow( 10, $exp ) );
	}

	/**
	 * Tax percentage charged on an order item: the sum of the WooCommerce tax
	 * rates applied to it, falling back to tax / net when a rate was deleted.
	 */
	private static function item_tax_rate( $item ) {
		$taxes = $item->get_taxes();
		$rate  = 0.0;
		$found = false;
		if ( ! empty( $taxes['total'] ) ) {
			foreach ( $taxes['total'] as $rate_id => $amount ) {
				if ( '' === $amount || 0.0 === (float) $amount ) {
					continue;
				}
				$percent = WC_Tax::get_rate_percent_value( $rate_id );
				if ( $percent > 0 ) {
					$rate += (float) $percent;
					$found = true;
				}
			}
		}
		if ( ! $found ) {
			$net = (float) $item->get_total();
			$tax = (float) $item->get_total_tax();
			$rate = ( $net > 0 && $tax > 0 ) ? round( $tax / $net * 100, 2 ) : 0.0;
		}
		return $rate;
	}

	private static function product_hsn( $product ) {
		if ( ! $product ) {
			return '';
		}
		$hsn = $product->get_meta( self::META_HSN );
		if ( ! $hsn && $product->get_parent_id() ) {
			$parent = wc_get_product( $product->get_parent_id() );
			$hsn    = $parent ? $parent->get_meta( self::META_HSN ) : '';
		}
		return preg_match( '/^(\d{2}|\d{4}|\d{6}|\d{8})$/', (string) $hsn ) ? (string) $hsn : '';
	}

	/** Drop empty values so optional API fields are omitted rather than sent as "". */
	private static function compact( $data ) {
		return array_filter(
			$data,
			function ( $v ) {
				return null !== $v && '' !== $v && array() !== $v;
			}
		);
	}

	private static function build_payload( $order ) {
		$currency = $order->get_currency();
		$lines    = array();

		foreach ( $order->get_items() as $item ) {
			$qty      = (float) $item->get_quantity();
			$subtotal = self::to_minor( $item->get_subtotal(), $currency ); // before coupons, excl. tax
			$total    = self::to_minor( $item->get_total(), $currency );    // after coupons, excl. tax
			$name     = $item->get_name();
			$unit     = $qty > 0 ? self::to_minor( (float) $item->get_subtotal() / $qty, $currency ) : $subtotal;

			// If the unit price does not multiply back to the line amount exactly
			// (e.g. 10.00 / 3), bill the line as a single unit so totals match the order.
			if ( $qty <= 0 || (int) round( $unit * $qty ) !== $subtotal ) {
				$name = sprintf( '%s x %s', $name, $qty );
				$unit = $subtotal;
				$qty  = 1;
			}

			$product = $item->get_product();
			$lines[] = self::compact(
				array(
					'description'     => $name,
					'sku'             => $product ? $product->get_sku() : '',
					'hsn_code'        => self::product_hsn( $product ),
					'quantity'        => $qty,
					'unit_amount'     => $unit,
					'discount_amount' => max( 0, $subtotal - $total ),
					'tax_rate'        => self::item_tax_rate( $item ),
				)
			);
		}

		foreach ( $order->get_items( 'shipping' ) as $item ) {
			$amount = self::to_minor( $item->get_total(), $currency );
			if ( $amount <= 0 ) {
				continue;
			}
			$lines[] = self::compact(
				array(
					'description' => sprintf( 'Shipping: %s', $item->get_name() ),
					'hsn_code'    => (string) get_option( 'billing_api_shipping_hsn', '' ),
					'quantity'    => 1,
					'unit_amount' => $amount,
					'tax_rate'    => self::item_tax_rate( $item ),
				)
			);
		}

		foreach ( $order->get_items( 'fee' ) as $item ) {
			$amount = self::to_minor( $item->get_total(), $currency );
			if ( $amount <= 0 ) {
				continue; // negative fees are not supported; the total check below flags the difference
			}
			$lines[] = array(
				'description' => $item->get_name(),
				'quantity'    => 1,
				'unit_amount' => $amount,
				'tax_rate'    => self::item_tax_rate( $item ),
			);
		}

		$use_shipping = $order->has_shipping_address();
		$state        = $use_shipping ? $order->get_shipping_state() : $order->get_billing_state();
		$country      = $use_shipping ? $order->get_shipping_country() : $order->get_billing_country();
		$customer     = self::compact(
			array(
				'name'    => trim( $order->get_formatted_billing_full_name() ) ?: ( $order->get_billing_company() ?: 'Customer' ),
				'email'   => is_email( $order->get_billing_email() ) ? $order->get_billing_email() : '',
				'phone'   => $order->get_billing_phone(),
				'gstin'   => strtoupper( (string) $order->get_meta( '_billing_gstin' ) ),
				'state'   => $state,
				'country' => 2 === strlen( (string) $country ) ? $country : '',
				'address' => self::compact(
					array(
						'line1'       => $order->get_billing_address_1(),
						'line2'       => $order->get_billing_address_2(),
						'city'        => $order->get_billing_city(),
						'state'       => $order->get_billing_state(),
						'postal_code' => $order->get_billing_postcode(),
						'country'     => $order->get_billing_country(),
					)
				),
			)
		);

		$payload = array(
			'external_id'   => 'woo-' . $order->get_id(),
			'currency'      => $currency,
			'tax_inclusive' => false, // line amounts above are always excl. tax
			'customer'      => $customer,
			'line_items'    => $lines,
			'metadata'      => array(
				'source'       => 'woocommerce',
				'order_number' => (string) $order->get_order_number(),
			),
		);

		if ( $order->is_paid() ) {
			$payload['payment'] = (object) self::compact(
				array(
					'method'    => $order->get_payment_method_title(),
					'reference' => $order->get_transaction_id(),
				)
			);
		}

		/**
		 * Filter the invoice payload before it is sent, e.g. to add `exchange_rate`
		 * for orders that are not in the merchant's base currency.
		 */
		return apply_filters( 'billing_api_invoice_payload', $payload, $order );
	}

	/**
	 * Return the Billing API invoice id for the order, creating the invoice if needed.
	 * Safe to call repeatedly: the id is stored on the order, and the API itself
	 * de-duplicates on external_id.
	 *
	 * @return string|null
	 */
	public static function ensure_invoice( $order ) {
		if ( ! $order instanceof WC_Order || $order instanceof WC_Order_Refund || ! self::is_configured() ) {
			return null;
		}
		$invoice_id = $order->get_meta( self::META_INVOICE_ID );
		if ( $invoice_id ) {
			return $invoice_id;
		}

		$invoice = self::request( 'POST', '/v1/invoices', self::build_payload( $order ) );
		if ( is_wp_error( $invoice ) ) {
			$order->add_order_note( sprintf( 'Billing API: could not create invoice (%s).', $invoice->get_error_message() ) );
			wc_get_logger()->error( 'Invoice creation failed for order ' . $order->get_id() . ': ' . $invoice->get_error_message(), array( 'source' => 'billing-api-invoices' ) );
			return null;
		}

		$order->update_meta_data( self::META_INVOICE_ID, $invoice['id'] );
		$order->update_meta_data( self::META_INVOICE_NUMBER, $invoice['number'] );
		$order->save();

		$note        = sprintf( 'Billing API: invoice %s created.', $invoice['number'] );
		$order_total = self::to_minor( $order->get_total(), $order->get_currency() );
		if ( (int) $invoice['total'] !== $order_total ) {
			$note .= sprintf( ' Note: invoice total (%d) differs from the order total (%d) in minor units - check tax rounding, fees and tax settings.', $invoice['total'], $order_total );
		}
		$order->add_order_note( $note );

		return $invoice['id'];
	}

	public static function on_order_ready( $order_id ) {
		self::ensure_invoice( wc_get_order( $order_id ) );
	}

	/* ---------------------------------------------------------------------
	 * Email attachment
	 * ------------------------------------------------------------------- */

	private static function temp_dir() {
		$upload = wp_upload_dir();
		return trailingslashit( $upload['basedir'] ) . 'billing-api-invoices';
	}

	/** Download the invoice PDF to a private temp file and return its path. */
	private static function download_pdf( $order, $invoice_id ) {
		$order_id = $order->get_id();
		if ( isset( self::$pdf_cache[ $order_id ] ) && file_exists( self::$pdf_cache[ $order_id ] ) ) {
			return self::$pdf_cache[ $order_id ];
		}

		$response = self::request( 'GET', '/v1/invoices/' . rawurlencode( $invoice_id ) . '/pdf', null, true );
		if ( is_wp_error( $response ) ) {
			wc_get_logger()->error( 'Invoice PDF download failed for order ' . $order_id . ': ' . $response->get_error_message(), array( 'source' => 'billing-api-invoices' ) );
			return null;
		}
		$body = wp_remote_retrieve_body( $response );
		if ( 0 !== strpos( $body, '%PDF' ) ) {
			return null;
		}

		// Each PDF goes in its own unguessable folder so the file name the customer
		// sees stays clean; folders are removed by the daily cleanup.
		$base = self::temp_dir();
		$dir  = $base . '/' . wp_generate_password( 24, false );
		if ( ! wp_mkdir_p( $dir ) ) {
			return null;
		}
		if ( ! file_exists( $base . '/.htaccess' ) ) {
			file_put_contents( $base . '/.htaccess', "Deny from all\n" ); // phpcs:ignore WordPress.WP.AlternativeFunctions
			file_put_contents( $base . '/index.html', '' ); // phpcs:ignore WordPress.WP.AlternativeFunctions
		}

		$number = $order->get_meta( self::META_INVOICE_NUMBER );
		$path   = $dir . '/' . sanitize_file_name( 'invoice-' . ( $number ? $number : $order_id ) . '.pdf' );
		if ( false === file_put_contents( $path, $body ) ) { // phpcs:ignore WordPress.WP.AlternativeFunctions
			return null;
		}

		self::$pdf_cache[ $order_id ] = $path;
		return $path;
	}

	public static function attach_invoice( $attachments, $email_id, $object ) {
		if ( ! $object instanceof WC_Order || $object instanceof WC_Order_Refund ) {
			return $attachments;
		}
		$enabled = (array) get_option( 'billing_api_emails', array( 'customer_processing_order', 'customer_completed_order', 'customer_invoice' ) );
		if ( ! in_array( $email_id, $enabled, true ) ) {
			return $attachments;
		}

		// A failure here must never stop the order email from going out.
		try {
			$invoice_id = self::ensure_invoice( $object );
			$path       = $invoice_id ? self::download_pdf( $object, $invoice_id ) : null;
			if ( $path ) {
				$attachments[] = $path;
			}
		} catch ( \Throwable $e ) {
			wc_get_logger()->error( 'Invoice attachment failed: ' . $e->getMessage(), array( 'source' => 'billing-api-invoices' ) );
		}
		return $attachments;
	}

	public static function cleanup_temp_files() {
		$base = self::temp_dir();
		foreach ( (array) glob( $base . '/*', GLOB_ONLYDIR ) as $dir ) {
			if ( filemtime( $dir ) > time() - DAY_IN_SECONDS ) {
				continue;
			}
			array_map( 'unlink', (array) glob( $dir . '/*' ) );
			rmdir( $dir ); // phpcs:ignore WordPress.WP.AlternativeFunctions
		}
	}

	/* ---------------------------------------------------------------------
	 * Refunds
	 * ------------------------------------------------------------------- */

	public static function on_order_refunded( $order_id, $refund_id ) {
		$order  = wc_get_order( $order_id );
		$refund = wc_get_order( $refund_id );
		if ( ! $order || ! $refund || ! self::is_configured() ) {
			return;
		}
		$invoice_id = $order->get_meta( self::META_INVOICE_ID );
		if ( ! $invoice_id ) {
			return; // order was never invoiced (e.g. cancelled before payment)
		}
		$amount = self::to_minor( $refund->get_amount(), $order->get_currency() );
		if ( $amount <= 0 ) {
			return;
		}

		$result = self::request(
			'POST',
			'/v1/invoices/' . rawurlencode( $invoice_id ) . '/refunds',
			self::compact(
				array(
					'amount'      => $amount,
					'reason'      => $refund->get_reason(),
					'external_id' => 'woo-refund-' . $refund_id,
				)
			)
		);

		if ( is_wp_error( $result ) ) {
			$order->add_order_note( sprintf( 'Billing API: could not record refund (%s).', $result->get_error_message() ) );
			return;
		}
		$order->add_order_note( sprintf( 'Billing API: refund recorded, credit note %s issued.', $result['credit_note']['number'] ) );
	}

	/* ---------------------------------------------------------------------
	 * Product HSN field and order action
	 * ------------------------------------------------------------------- */

	public static function render_hsn_field() {
		woocommerce_wp_text_input(
			array(
				'id'          => self::META_HSN,
				'label'       => __( 'HSN/SAC code', 'billing-api-invoices' ),
				'desc_tip'    => true,
				'description' => __( '2, 4, 6 or 8 digits. Printed on GST invoices.', 'billing-api-invoices' ),
			)
		);
	}

	public static function save_hsn_field( $product_id ) {
		// WooCommerce verifies the product-edit nonce before firing this hook.
		$hsn     = isset( $_POST[ self::META_HSN ] ) ? preg_replace( '/\D/', '', sanitize_text_field( wp_unslash( $_POST[ self::META_HSN ] ) ) ) : ''; // phpcs:ignore WordPress.Security.NonceVerification
		$product = wc_get_product( $product_id );
		if ( $product ) {
			$product->update_meta_data( self::META_HSN, $hsn );
			$product->save();
		}
	}

	public static function add_order_action( $actions ) {
		$actions['billing_api_create_invoice'] = __( 'Create Billing API invoice', 'billing-api-invoices' );
		return $actions;
	}

	public static function run_order_action( $order ) {
		self::ensure_invoice( $order );
	}
}

add_action(
	'plugins_loaded',
	function () {
		if ( class_exists( 'WooCommerce' ) ) {
			Billing_API_Invoices::init();
		}
	}
);

// Compatible with High-Performance Order Storage (all order access goes through WC_Order).
add_action(
	'before_woocommerce_init',
	function () {
		if ( class_exists( \Automattic\WooCommerce\Utilities\FeaturesUtil::class ) ) {
			\Automattic\WooCommerce\Utilities\FeaturesUtil::declare_compatibility( 'custom_order_tables', __FILE__, true );
		}
	}
);

register_activation_hook(
	__FILE__,
	function () {
		if ( ! wp_next_scheduled( Billing_API_Invoices::CRON_HOOK ) ) {
			wp_schedule_event( time() + DAY_IN_SECONDS, 'daily', Billing_API_Invoices::CRON_HOOK );
		}
	}
);

register_deactivation_hook(
	__FILE__,
	function () {
		wp_clear_scheduled_hook( Billing_API_Invoices::CRON_HOOK );
	}
);
